import net from "node:net"
import stream from "node:stream"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { connectPipe, stdioSocket } from "@vibest/client/pipe"
import { SocketConnector } from "@vibest/client/socket-connector"
import { Db } from "@vibest/core/db"
import { VibestdIdentity } from "@vibest/core/identity"
import { MachineTransport, REMOTE_LINE, RETRY_FIRST, sshArgv, targetProblem, nameProblem } from "@vibest/core/machines"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import type { SpawnInput, Sessions } from "@vibest/core/sessions"
import * as VibestPlugin from "@vibest/plugin"
import { peerHeaders, sessionHeaders } from "@vibest/protocol/protocol"
import { randomId } from "@vibest/schema/id"
import { OUTBOX_ITEM_MAX, type OutboxItem, PROMPT_MAX } from "@vibest/schema/machine"
import * as Server from "@vibest/server/server"
import {
  Cause,
  Clock,
  type Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Stream,
} from "effect"
import { RpcClient } from "effect/rpc"
import * as Socket from "effect/socket/Socket"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { teardown } from "../src/cli.ts"
import { pipeStdio } from "../src/connect.ts"
import {
  FakeGit,
  makeRepository,
  runVibest,
  tempDirectory,
  testLayer,
  type TestOptions,
  until,
  untilVirtual,
  yieldToIo,
} from "./fakes.ts"

const served = (options?: TestOptions) =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(testLayer(options)),
  )

type Pipes = {
  readonly cut: Effect.Effect<void>
  readonly hold: Effect.Effect<void>
}

type Route = {
  socket?: string
  exit?: { readonly code: number; readonly stderr: string }
  readonly pipes: Array<Pipes>
}

const closed = () => new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: new Error("pipe closed") }) })

class Net {
  readonly routes = new Map<string, Route>()
  readonly argv: Array<ReadonlyArray<string>> = []

  route(host: string, socket: string) {
    const route = this.routes.get(host) ?? { pipes: [] }
    route.socket = socket
    delete route.exit
    this.routes.set(host, route)
    return route
  }

  fail(host: string, code: number, stderr: string) {
    const route = this.routes.get(host) ?? { pipes: [] }
    route.exit = { code, stderr }
    this.routes.set(host, route)
  }

  cutAll(host: string) {
    return Effect.forEach(this.routes.get(host)?.pipes ?? [], (p) => p.cut, { discard: true })
  }

  transport(dial: SocketConnector["Service"]): MachineTransport["Service"] {
    const { argv: seen, routes } = this
    return (argv) =>
      Effect.gen(function* () {
        seen.push([...argv])
        const host = argv.at(-2)!
        const route = routes.get(host)
        if (route?.socket === undefined || route.exit !== undefined) {
          const exit = route?.exit ?? { code: 255, stderr: `ssh: Could not resolve hostname ${host}` }
          return {
            socket: Socket.make({
              reader: Effect.fail(closed()),
              writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
            }),
            exited: Effect.succeed(exit),
          }
        }
        const inner = yield* dial(route.socket)
        const cut = yield* Deferred.make<void>()
        const held = { on: false }
        route.pipes.push({
          cut: Deferred.succeed(cut, undefined).pipe(Effect.asVoid),
          hold: Effect.sync(() => (held.on = true)),
        })
        const failOnCut = Deferred.await(cut).pipe(Effect.andThen(Effect.fail(closed())))
        const socket = Socket.make({
          reader: Effect.map(inner.reader, (r) => ({
            pull: Effect.suspend(() => (held.on ? Effect.never : r.pull)).pipe(Effect.raceFirst(failOnCut)),
            upgrade: r.upgrade,
          })),
          writer: Effect.map(inner.writer, (w) => ({
            write: (chunk: Uint8Array | string | Socket.CloseEvent) => (held.on ? Effect.void : w.write(chunk)),
            writeAll: (chunks: readonly [Uint8Array | string, ...Array<Uint8Array | string>]) =>
              held.on ? Effect.void : w.writeAll(chunks),
          })),
        })
        return {
          socket,
          exited: Deferred.await(cut).pipe(Effect.as({ code: 255, stderr: `Connection to ${host} closed.` })),
        }
      })
  }
}

type Stack = Context.Context<Layer.Success<ReturnType<typeof served>>>

const stack = (net: Net) =>
  Effect.gen(function* () {
    const dial = yield* SocketConnector
    const context: Stack = yield* Layer.build(served({ transport: net.transport(dial) }))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context)
    const layout = yield* run(Layout)
    const raw = yield* connect(layout.socket)
    const cli = <A, E>(effect: Effect.Effect<A, E>) => RpcClient.withHeaders(effect, cliHeaders(layout.home))
    return { context, run, layout, raw, cli, id: (yield* run(VibestdIdentity)).id }
  })

const failureTag = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => "defect",
        onSome: (e) => (e as { readonly _tag: string })._tag,
      })
    : "success"

const overNodeSocket = (path: string) =>
  Effect.acquireRelease(
    Effect.sync(() => net.createConnection(path)),
    (conn) => Effect.sync(() => conn.destroy()),
  ).pipe(Effect.flatMap((conn) => stdioSocket(stream.Duplex.toWeb(conn) as unknown as Socket.InputTransformStream)))

const peers = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ id: string; name: string; callsMe: string }>`SELECT id, name, calls_me FROM peer ORDER BY id`,
)

describe("the peer caller", () => {
  it.effect("Peer.Hello over a stdin and stdout pipe records the peer; only Hello is allowed before it", () =>
    Effect.gen(function* () {
      const layout = yield* Layout
      const self = yield* VibestdIdentity
      const client = yield* connectPipe(yield* overNodeSocket(layout.socket))
      const peer = randomId()
      const as = <A, E, R>(effect: Effect.Effect<A, E, R>) => RpcClient.withHeaders(effect, peerHeaders(peer))
      assert.strictEqual(failureTag(yield* Effect.exit(as(client.List({})))), "InvalidCaller", "no Hello yet")
      const hello = yield* as(client["Peer.Hello"]({ id: peer, name: "mac-mini", callsMe: "mb" }))
      assert.deepStrictEqual({ id: hello.id, name: hello.name }, { id: self.id, name: self.name })
      assert.deepStrictEqual(yield* peers, [{ id: peer, name: "mac-mini", callsMe: "mb" }])
      yield* as(client["Peer.Hello"]({ id: peer, name: "mac-mini", callsMe: "renamed" }))
      assert.deepStrictEqual(yield* peers, [{ id: peer, name: "mac-mini", callsMe: "renamed" }])
      const refused: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
        client.Spawn({ prompt: "x", callerEnv: {} }),
        client.Launch({ argv: [], focus: false, callerEnv: {} }),
        client["Daemon.Stop"]({ instance: "x" }),
      ]
      for (const call of refused) assert.strictEqual(failureTag(yield* Effect.exit(as(call))), "InvalidCaller")
      const other = yield* Effect.exit(
        RpcClient.withHeaders(client["Peer.Hello"]({ id: peer, name: "x", callsMe: "y" }), peerHeaders(randomId())),
      )
      assert.strictEqual(failureTag(other), "Forbidden", "Hello names the caller")
    }).pipe(Effect.scoped, Effect.provide(served())),
  )

  it.effect("a Hello from this vibestd's own id records no peer", () =>
    Effect.gen(function* () {
      const layout = yield* Layout
      const self = yield* VibestdIdentity
      const client = yield* connect(layout.socket)
      const hello = yield* RpcClient.withHeaders(
        client["Peer.Hello"]({ id: self.id, name: "me", callsMe: "loop" }),
        peerHeaders(self.id),
      )
      assert.strictEqual(hello.id, self.id)
      assert.deepStrictEqual(yield* peers, [])
    }).pipe(Effect.scoped, Effect.provide(served())),
  )

  it.effect("vibest connect exits 1 when this machine's socket does not answer", () =>
    Effect.gen(function* () {
      const home = yield* tempDirectory("vibest-connect-")
      const exit = yield* Effect.exit(
        pipeStdio(`${home}/missing.sock`, { stdin: stream.Readable.from([]), stdout: new stream.PassThrough() }),
      )
      assert.strictEqual(failureTag(exit), "ConnectFailed")
      let code: number | undefined
      teardown(exit, (c) => (code = c))
      assert.strictEqual(code, 1)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.live("vibest connect is the user's: an agent is refused", () =>
    Effect.gen(function* () {
      const home = yield* tempDirectory("vibest-home-")
      const run = yield* runVibest(home, { HOME: home, VIBEST_HOME: home, VIBEST_SESSION_ID: randomId() }, ["connect"])
      assert.strictEqual(run.code, 1)
      assert.include(run.stderr, "an agent may not run vibest connect")
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})

describe("machine add, ls and rm", () => {
  it("ssh argv: options, the port as -p, the line last; bad names and targets are refused", () => {
    const options = ["ssh", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]
    assert.deepStrictEqual(sshArgv("root@h"), [...options, "root@h", REMOTE_LINE])
    assert.deepStrictEqual(sshArgv("root@h:2222"), [...options, "-p", "2222", "root@h", REMOTE_LINE])
    assert.deepStrictEqual(sshArgv("racknerd"), [...options, "racknerd", REMOTE_LINE])
    for (const target of ["root:secret@h", "root@h x", "-oProxyCommand=x", "a\nb", ""])
      assert.isString(targetProblem(target), target)
    assert.isUndefined(targetProblem("root@100.88.65.47"))
    assert.isString(nameProblem("a/b"))
    assert.isUndefined(nameProblem("rack-nerd_1.b"))
  })

  it.effect(
    "add records B's id and keeps the connection; B records A as a peer; the same B under another name is refused",
    () =>
      Effect.gen(function* () {
        const net = new Net()
        const a = yield* stack(net)
        const b = yield* stack(net)
        net.route("b-host", b.layout.socket)
        const added = yield* a.cli(a.raw["Machine.Add"]({ name: "mb", target: "b-host" }))
        assert.strictEqual(added.id, b.id)
        assert.strictEqual(added.vibestd, "test-host")
        assert.include(net.argv[0]!.join(" "), "BatchMode=yes")
        const [listed] = yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows[0]?.state === "connected")
        assert.strictEqual(listed!.id, b.id)
        assert.strictEqual(listed!.vibestd, "test-host")
        assert.lengthOf(net.argv, 1, "add dials once and keeps that connection")
        assert.deepStrictEqual(yield* b.run(peers), [{ id: a.id, name: "test-host", callsMe: "mb" }])
        const again = yield* Effect.flip(a.cli(a.raw["Machine.Add"]({ name: "mb-again", target: "b-host" })))
        assert.strictEqual(again._tag, "AlreadyAdded")
        assert.include(again.message, "this is the vibestd already added as mb")
        assert.strictEqual((yield* a.cli(a.raw["Machine.List"]())).length, 1)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("two adds of one name at once: one is added, the other fails as MachineFailed", () =>
    Effect.gen(function* () {
      const net = new Net()
      const a = yield* stack(net)
      const b = yield* stack(net)
      const c = yield* stack(net)
      net.route("b-host", b.layout.socket)
      net.route("c-host", c.layout.socket)
      const both = yield* Effect.all(
        [
          Effect.exit(a.cli(a.raw["Machine.Add"]({ name: "mb", target: "b-host" }))),
          Effect.exit(a.cli(a.raw["Machine.Add"]({ name: "mb", target: "c-host" }))),
        ],
        { concurrency: "unbounded" },
      )
      assert.deepStrictEqual(both.map(failureTag).sort(), ["MachineFailed", "success"])
      const lost = both.find(Exit.isFailure)!
      assert.include(String(Cause.squash(lost.cause)), "a machine named mb is already added")
      assert.lengthOf(yield* a.cli(a.raw["Machine.List"]()), 1)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "nothing is recorded when ssh fails, when vibest is missing there, or when the target is this vibestd",
    () =>
      Effect.gen(function* () {
        const net = new Net()
        const a = yield* stack(net)
        net.route("self", a.layout.socket)
        net.fail("bare", 127, "vibest is not installed here")
        const cases: ReadonlyArray<readonly [string, string]> = [
          ["nowhere", "Could not resolve hostname nowhere"],
          ["bare", "vibest is not installed on m"],
          ["self", "m is this vibestd"],
        ]
        for (const [target, message] of cases) {
          const refused = yield* Effect.flip(a.cli(a.raw["Machine.Add"]({ name: "m", target })))
          assert.include(refused.message, message, target)
        }
        assert.deepStrictEqual(yield* a.cli(a.raw["Machine.List"]()), [])
        const bad = yield* Effect.flip(a.cli(a.raw["Machine.Add"]({ name: "m", target: "root:pw@h" })))
        assert.include(bad.message, "password")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("a cut pipe goes unreachable with the reason and reconnects; connected_at and the peer row follow", () =>
    Effect.gen(function* () {
      const net = new Net()
      const a = yield* stack(net)
      const b = yield* stack(net)
      net.route("b-host", b.layout.socket)
      yield* a.cli(a.raw["Machine.Add"]({ name: "mb", target: "b-host" }))
      const first = (yield* until(a.cli(a.raw["Machine.List"]()), (r) => r[0]?.state === "connected"))[0]!
      net.fail("b-host", 255, "ssh: connect to host b-host port 22: Connection refused")
      yield* net.cutAll("b-host")
      const down = (yield* until(a.cli(a.raw["Machine.List"]()), (r) => r[0]?.state === "unreachable"))[0]!
      assert.match(down.reason ?? "", /closed|refused/)
      net.route("b-host", b.layout.socket)
      const back = (yield* untilVirtual(a.cli(a.raw["Machine.List"]()), (r) => r[0]?.state === "connected"))[0]!
      assert.isAbove(back.connectedAt, first.connectedAt - 1)
      assert.isAtLeast(net.argv.length, 2)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("a cut connection is retried on the ladder: 0.5 s, then twice as long each time", () =>
    Effect.gen(function* () {
      const net = new Net()
      const a = yield* stack(net)
      const b = yield* stack(net)
      net.route("b-host", b.layout.socket)
      yield* a.cli(a.raw["Machine.Add"]({ name: "mb", target: "b-host" }))
      yield* until(a.cli(a.raw["Machine.List"]()), (r) => r[0]?.state === "connected")
      const refused = (round: number) => `ssh: connect to host b-host port 22: Connection refused ${round}`
      net.fail("b-host", 255, refused(0))
      yield* net.cutAll("b-host")
      yield* until(a.cli(a.raw["Machine.List"]()), (r) => r[0]?.state === "unreachable")
      let wait = Duration.toMillis(RETRY_FIRST)
      for (let round = 1; round <= 5; round++) {
        const dials = net.argv.length
        net.fail("b-host", 255, refused(round))
        yield* TestClock.adjust(wait - 1)
        yield* yieldToIo
        assert.strictEqual(net.argv.length, dials, `no dial before ${wait} ms`)
        yield* TestClock.adjust(1)
        yield* until(a.cli(a.raw["Machine.List"]()), (r) => r[0]?.reason?.includes(refused(round)) === true)
        assert.strictEqual(net.argv.length, dials + 1, `one dial at ${wait} ms`)
        wait *= 2
      }
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("another vibestd behind the target is different: no retry until removed and added again", () =>
    Effect.gen(function* () {
      const net = new Net()
      const a = yield* stack(net)
      const b = yield* stack(net)
      const c = yield* stack(net)
      net.route("b-host", b.layout.socket)
      yield* a.cli(a.raw["Machine.Add"]({ name: "mb", target: "b-host" }))
      yield* until(a.cli(a.raw["Machine.List"]()), (r) => r[0]?.state === "connected")
      net.route("b-host", c.layout.socket)
      yield* net.cutAll("b-host")
      const different = (yield* untilVirtual(a.cli(a.raw["Machine.List"]()), (r) => r[0]?.state === "different"))[0]!
      assert.include(different.reason ?? "", `mb now answers as a different vibestd (${c.id.slice(0, 8)})`)
      assert.strictEqual(different.id, b.id)
      const dials = net.argv.length
      yield* TestClock.adjust("10 minutes")
      yield* yieldToIo
      assert.strictEqual(net.argv.length, dials, "no retry")
      yield* a.cli(a.raw["Machine.Remove"]({ name: "mb" }))
      const readded = yield* a.cli(a.raw["Machine.Add"]({ name: "mb", target: "b-host" }))
      assert.strictEqual(readded.id, c.id)
      yield* until(a.cli(a.raw["Machine.List"]()), (r) => r[0]?.state === "connected" && r[0].id === c.id)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})

const peerSession = {
  agent: "general",
  harnessId: "pi" as const,
  provider: null,
  model: null,
  harnessSessionId: null,
  runtime: "fake",
  address: { machine: "local", id: "" },
  status: "unknown" as const,
  startedAt: null,
  exitedAt: null,
  turnState: "none" as const,
  turnPromptedAt: 0,
  metadata: {},
}

const fakeSpawns = (spawns: Array<SpawnInput>) => (sessions: Sessions["Service"], db: Db["Service"]) => ({
  ...sessions,
  spawn: (input: SpawnInput) =>
    Effect.gen(function* () {
      spawns.push(input)
      const id = randomId()
      const at = yield* Clock.currentTimeMillis
      const inserted = yield* db.insertSession(
        { ...peerSession, id, name: input.name, createdAt: at, lastActive: at },
        input.projectId,
        {
          cwd: input.root,
          task: input.prompt,
          parentSessionId: input.parentSessionId,
          request: input.request,
          origin: input.origin,
        },
      )
      const before = typeof inserted === "object" ? inserted : undefined
      return {
        id: before?.id ?? id,
        harness: "pi" as const,
        provider: undefined,
        model: undefined,
        runtime: "fake",
        decidedBy: {},
        trace: [],
      }
    }),
})

const REMOTE = "git@example.com:o/r.git"
const COMMIT = "0123456789abcdef0123456789abcdef01234567"
const REPOSITORY = { origin: REMOTE, head: COMMIT, commits: [COMMIT] }

const repoStack = (net?: Net, options: TestOptions = {}) =>
  Effect.gen(function* () {
    const spawns: Array<SpawnInput> = []
    const transport = net === undefined ? {} : { transport: net.transport(yield* SocketConnector) }
    const context = yield* Layer.build(
      served({ ...transport, ...options, sessions: options.sessions ?? fakeSpawns(spawns) }),
    )
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context)
    const layout = yield* run(Layout)
    const db = yield* run(Db)
    const directory = yield* tempDirectory("vibest-b-checkout-")
    yield* (yield* run(FakeGit)).repository(directory, REPOSITORY)
    const project = yield* db.createProject(directory, [{ path: directory, remote: REMOTE }])
    const raw = yield* connect(layout.socket)
    const cli = <A, E>(effect: Effect.Effect<A, E>) => RpcClient.withHeaders(effect, cliHeaders(layout.home))
    const as = (peer: string, aProject: string) =>
      Effect.gen(function* () {
        yield* RpcClient.withHeaders(
          raw["Peer.Hello"]({ id: peer, name: `a-${peer.slice(0, 4)}`, callsMe: "mb" }),
          peerHeaders(peer),
        )
        const call = <A, E>(effect: Effect.Effect<A, E>) => RpcClient.withHeaders(effect, peerHeaders(peer, aProject))
        return Object.assign(call, { outbox: raw["Peer.Outbox"](undefined, { headers: peerHeaders(peer, aProject) }) })
      })
    const spawn = (call: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>, request = randomId()) =>
      call(raw["Peer.Spawn"]({ repository: REMOTE, commit: COMMIT, prompt: "do it", reportTo: "a-main", request }))
    return { run, db, raw, cli, as, spawn, spawns, directory, project, layout, id: (yield* run(VibestdIdentity)).id }
  })

const peerB = repoStack()

const outboxRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{
      peerId: string
      sessionId: string
      kind: string
    }>`SELECT peer_id, session_id, kind FROM outbox ORDER BY created_at`,
)

const finish = (db: Db["Service"], session: string, message: string) =>
  db.insertInbox({ sessionId: session, kind: "result", message, details: { status: "completed" } })

describe("another machine's vibestd runs agents here", () => {
  it.effect("Peer.Spawn records peer.start and no parent; a retry finds it; no project or commit fails clearly", () =>
    Effect.gen(function* () {
      const b = yield* peerB
      const a = randomId()
      const call = yield* b.as(a, "aproj")
      const request = randomId()
      const spawned = yield* b.spawn(call, request)
      assert.strictEqual(spawned.directory, b.directory)
      assert.strictEqual(b.spawns[0]!.commit, COMMIT)
      assert.strictEqual(b.spawns[0]!.projectId, b.project)
      assert.deepStrictEqual(
        (yield* call(b.raw.List({}))).sessions.map((r) => r.id),
        [spawned.session],
      )
      assert.deepStrictEqual(
        yield* (yield* b.as(a, "other"))(b.raw.List({})),
        { sessions: [], machines: [] },
        "another project of A sees none",
      )
      const row = yield* b.run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql<{
              parent: string | null
              reportTo: string | null
            }>`SELECT parent_session_id AS parent, report_to_session_id AS report_to FROM session WHERE id = ${spawned.session}`,
        ),
      )
      assert.deepStrictEqual(row, [{ parent: null, reportTo: null }])
      assert.strictEqual((yield* b.spawn(call, request)).session, spawned.session, "the same request")
      const noCommit = yield* Effect.flip(
        call(
          b.raw["Peer.Spawn"]({
            repository: REMOTE,
            commit: "fedcba9",
            prompt: "x",
            reportTo: "m",
            request: randomId(),
          }),
        ),
      )
      assert.strictEqual(noCommit._tag, "NoCommit")
      assert.include(noCommit.message, `does not have fedcba9: push it and fetch it there`)
      const noProject = yield* Effect.flip(
        call(
          b.raw["Peer.Spawn"]({ repository: "other", commit: COMMIT, prompt: "x", reportTo: "m", request: randomId() }),
        ),
      )
      assert.strictEqual(noProject._tag, "NoProject")
      assert.include(noProject.message, "vibest project add")
      const spawnsBefore = b.spawns.length
      const big = yield* Effect.flip(
        call(
          b.raw["Peer.Spawn"]({
            repository: REMOTE,
            commit: COMMIT,
            prompt: "é".repeat(PROMPT_MAX / 2 + 1),
            reportTo: "m",
            request: randomId(),
          }),
        ),
      )
      assert.strictEqual(big._tag, "PromptTooLarge")
      assert.include(big.message, "at most 1048576 bytes (1 MiB)")
      assert.lengthOf(b.spawns, spawnsBefore, "nothing was started for it")
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("a result goes to the outbox, not to B's inbox delivery; the stream sends it and Ack deletes it", () =>
    Effect.gen(function* () {
      const b = yield* peerB
      const a = randomId()
      const call = yield* b.as(a, "aproj")
      const { session } = yield* b.spawn(call)
      const items = yield* Queue.unbounded<OutboxItem>()
      yield* call.outbox.pipe(
        Stream.runForEach((item) => Queue.offer(items, item)),
        Effect.forkScoped,
      )
      const result = yield* finish(b.db, session, "General Agent completed")
      assert.strictEqual(result.status, "dropped", "B's own delivery never sees it")
      assert.strictEqual((yield* b.db.latestInbox(session, "result"))?.message, "General Agent completed")
      const item = yield* Queue.take(items)
      assert.deepStrictEqual(
        { session: item.session, recipient: item.recipient, kind: item.kind, content: item.content, cut: item.cut },
        { session, recipient: "a-main", kind: "result", content: "General Agent completed", cut: undefined },
      )
      assert.lengthOf(yield* b.run(outboxRows), 1)
      yield* call(b.raw["Peer.Ack"]({ ids: [item.id] }))
      assert.deepStrictEqual(yield* b.run(outboxRows), [])
      const big = "é".repeat(OUTBOX_ITEM_MAX)
      yield* finish(b.db, session, big)
      const cut = yield* Queue.take(items)
      assert.isTrue(cut.cut)
      assert.strictEqual(new TextEncoder().encode(cut.content).length, OUTBOX_ITEM_MAX)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("a reconnect sends what was not acknowledged, in order", () =>
    Effect.gen(function* () {
      const b = yield* peerB
      const call = yield* b.as(randomId(), "aproj")
      const { session } = yield* b.spawn(call)
      yield* finish(b.db, session, "one")
      yield* b.db.insertInbox({ sessionId: session, kind: "notice", message: "two", details: {} })
      const first = yield* call.outbox.pipe(Stream.take(2), Stream.runCollect)
      assert.deepStrictEqual(
        first.map((i) => [i.kind, i.content]),
        [
          ["result", "one"],
          ["notice", "two"],
        ],
      )
      yield* call(b.raw["Peer.Ack"]({ ids: [first[0]!.id] }))
      const again = yield* call.outbox.pipe(Stream.take(1), Stream.runCollect)
      assert.deepStrictEqual(
        again.map((i) => i.id),
        [first[1]!.id],
      )
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("two peers: each gets only its own rows and cannot see or reach the other's session", () =>
    Effect.gen(function* () {
      const b = yield* peerB
      const a1 = yield* b.as(randomId(), "p1")
      const a2 = yield* b.as(randomId(), "p2")
      const { session } = yield* b.spawn(a1)
      yield* finish(b.db, session, "for a1")
      assert.lengthOf(yield* a1.outbox.pipe(Stream.take(1), Stream.runCollect), 1)
      const waiting = yield* a2.outbox.pipe(Stream.runCollect, Effect.timeoutOption("300 millis"), Effect.forkScoped)
      yield* a2(b.raw.List({}))
      yield* yieldToIo
      yield* TestClock.adjust("300 millis")
      assert.isTrue(Option.isNone(yield* Fiber.join(waiting)), "a2's stream stays empty")
      assert.deepStrictEqual(
        (yield* a1(b.raw.List({}))).sessions.map((r) => r.id),
        [session],
      )
      assert.deepStrictEqual(yield* a2(b.raw.List({})), { sessions: [], machines: [] })
      for (const call of [
        b.raw.Get({ id: session }),
        b.raw.Send({ id: session, message: "x" }),
        b.raw.Peek({ id: session }),
        b.raw.Interrupt({ id: session }),
        b.raw.Remove({ id: session }),
      ] as ReadonlyArray<Effect.Effect<unknown, unknown>>)
        assert.strictEqual(failureTag(yield* Effect.exit(a2(call))), "NoSuchSession")
      const sameProjectOtherPeer = yield* b.as(randomId(), "p1")
      assert.strictEqual(
        failureTag(yield* Effect.exit(sameProjectOtherPeer(b.raw.Get({ id: session })))),
        "NoSuchSession",
      )
      assert.strictEqual((yield* a1(b.raw.Get({ id: session.slice(0, 8) }))).result?.message, "for a1")
      yield* a1(b.raw.Send({ id: session, message: "again" }))
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("archive drops the session's rows; a peer may not call Machine.*", () =>
    Effect.gen(function* () {
      const b = yield* peerB
      const call = yield* b.as(randomId(), "aproj")
      const kept = yield* b.spawn(call)
      const archived = yield* b.spawn(call)
      yield* finish(b.db, kept.session, "waiting")
      yield* finish(b.db, archived.session, "archived")
      const row = (yield* b.db.getSession(archived.session))!
      yield* b.db.updateSession(archived.session, { metadata: { ...row.metadata, archived: true } })
      assert.deepStrictEqual(
        (yield* b.run(outboxRows)).map((r) => r.sessionId),
        [kept.session],
      )
      assert.strictEqual(failureTag(yield* Effect.exit(call(b.raw["Machine.List"]()))), "InvalidCaller")
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})

const inboxOf = (recipient: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{
        content: string
        kind: string
      }>`SELECT content, kind FROM inbox WHERE recipient_session_id = ${recipient} ORDER BY id`,
  )

const onB = (address: string) => address.slice(address.indexOf("/") + 1)

const twoMachines = (options: { readonly a?: TestOptions } = {}) =>
  Effect.gen(function* () {
    const net = new Net()
    const a = yield* repoStack(net, options.a)
    const b = yield* repoStack(net)
    net.route("b-host", b.layout.socket)
    const main = yield* a.db.coordinatorLaunch(a.project, "pi", false, {
      runtime: "fake",
      address: { machine: "local", id: "main-pane" },
    })
    const coordinator = <A, E>(effect: Effect.Effect<A, E>) =>
      RpcClient.withHeaders(effect, sessionHeaders({ sessionId: main.sessionId, projectId: a.project }))
    yield* a.cli(a.raw["Machine.Add"]({ name: "mb", target: "b-host" }))
    yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows[0]?.state === "connected")
    return { net, a, b, main: main.sessionId, coordinator }
  })

describe("vibest run --machine and remote sessions", () => {
  it.effect("List has every machine with its state; an unreachable one gives no sessions and says why", () =>
    Effect.gen(function* () {
      const { net, a, b, coordinator } = yield* twoMachines()
      const c = yield* repoStack(net)
      net.route("c-host", c.layout.socket)
      yield* a.cli(a.raw["Machine.Add"]({ name: "mc", target: "c-host" }))
      const spawned = yield* coordinator(a.raw.Spawn({ machine: "mb", prompt: "x", callerEnv: {} }))
      yield* coordinator(a.raw.Spawn({ machine: "mc", prompt: "y", callerEnv: {} }))
      net.fail("c-host", 255, "ssh: connect to host c-host port 22: Connection refused")
      yield* net.cutAll("c-host")
      yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows[1]?.state === "unreachable")
      const listed = yield* coordinator(a.raw.List({}))
      assert.deepStrictEqual(
        listed.sessions.filter((row) => row.machine !== undefined).map((row) => [row.id, row.machine]),
        [[spawned.id, "mb"]],
      )
      assert.deepStrictEqual(
        listed.machines.map((m) => [m.name, m.state]),
        [
          ["mb", "connected"],
          ["mc", "unreachable"],
        ],
      )
      assert.isUndefined(listed.machines[0]!.reason)
      assert.match(listed.machines[1]!.reason ?? "", /closed|refused/)
      assert.isNumber(listed.machines[1]!.since)
      assert.lengthOf(b.spawns, 1)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("run --machine without a main agent: no report-to, the result stays on B and Get mb/<id> reads it", () =>
    Effect.gen(function* () {
      const net = new Net()
      const a = yield* repoStack(net)
      const b = yield* repoStack(net)
      net.route("b-host", b.layout.socket)
      yield* a.cli(a.raw["Machine.Add"]({ name: "mb", target: "b-host" }))
      yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows[0]?.state === "connected")
      const checkout = yield* a.run(makeRepository)
      yield* (yield* a.run(FakeGit)).update(checkout, REPOSITORY)
      const here = <A, E>(effect: Effect.Effect<A, E>) => RpcClient.withHeaders(effect, cliHeaders(checkout))
      const spawned = yield* here(a.raw.Spawn({ machine: "mb", prompt: "alone", callerEnv: {} }))
      yield* finish(b.db, onB(spawned.id), "kept on B")
      assert.deepStrictEqual(yield* b.run(outboxRows), [], "nothing to send back")
      const got = yield* here(a.raw.Get({ id: spawned.id.slice(0, 11) }))
      assert.strictEqual(got.id, spawned.id)
      assert.strictEqual(got.result?.message, "kept on B")
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("a session another machine started may not start agents", () =>
    Effect.gen(function* () {
      const b = yield* peerB
      const call = yield* b.as(randomId(), "aproj")
      const { session } = yield* b.spawn(call)
      const refused = yield* Effect.flip(
        RpcClient.withHeaders(
          b.raw.Spawn({ prompt: "more", callerEnv: {} }),
          sessionHeaders({ sessionId: session, projectId: b.project }),
        ),
      )
      assert.strictEqual(refused._tag, "Forbidden")
      assert.lengthOf(b.spawns, 1)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "a forwarded run starts a B session and nothing on A; its result arrives once as a notice; B's row is then deleted",
    () =>
      Effect.gen(function* () {
        const { a, b, main, coordinator } = yield* twoMachines()
        const spawned = yield* coordinator(a.raw.Spawn({ machine: "mb", prompt: "do it there", callerEnv: {} }))
        assert.match(spawned.id, /^mb\/[0-9a-f-]{36}$/, "the address, as every other method answers")
        assert.isUndefined(yield* a.db.getSession(onB(spawned.id)), "A stores no session")
        assert.strictEqual(b.spawns[0]!.commit, COMMIT)
        yield* finish(b.db, onB(spawned.id), "General Agent completed")
        const [notice] = yield* until(a.run(inboxOf(main)), (rows) => rows.length === 1)
        assert.strictEqual(notice!.kind, "notice")
        assert.strictEqual(notice!.content, `${spawned.id.slice(0, 11)}: General Agent completed`)
        yield* until(b.run(outboxRows), (rows) => rows.length === 0)
        const address = spawned.id.slice(0, 11)
        const got = yield* coordinator(a.raw.Get({ id: address }))
        assert.strictEqual(got.id, spawned.id)
        assert.strictEqual(got.machine, "mb")
        assert.strictEqual(got.result?.message, "General Agent completed")
        assert.deepStrictEqual(yield* coordinator(a.raw.Send({ id: address, message: "more" })), {
          id: spawned.id,
        })
        const listed = yield* coordinator(a.raw.List({}))
        assert.deepInclude(
          listed.sessions.map((row) => [row.id, row.machine]),
          [spawned.id, "mb"],
        )
        assert.lengthOf(yield* a.run(inboxOf(main)), 1, "one notice")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "without --runtime A sends the caller's terminal runtime, else its main agent's; --runtime wins; B lacking it fails clearly",
    () =>
      Effect.gen(function* () {
        const term = VibestPlugin.Plugin.define({
          id: "runtime-term",
          caller: { kind: "term", env: ["TERM_PANE"], terminal: () => Effect.succeed("p1") },
          effect: () => Effect.void,
        })
        const { net, a, b, coordinator } = yield* twoMachines({ a: { plugins: [term] } })
        yield* coordinator(a.raw.Spawn({ machine: "mb", prompt: "x", callerEnv: {} }))
        yield* coordinator(a.raw.Spawn({ machine: "mb", prompt: "x", callerEnv: { TERM_PANE: "p1" } }))
        yield* coordinator(a.raw.Spawn({ machine: "mb", prompt: "x", callerEnv: { TERM_PANE: "p1" }, runtime: "rex" }))
        assert.deepStrictEqual(
          b.spawns.map((spawn) => spawn.runtime),
          ["fake", "term", "rex"],
        )
        const c = yield* repoStack(net, { sessions: (s) => s })
        net.route("c-host", c.layout.socket)
        yield* a.cli(a.raw["Machine.Add"]({ name: "mc", target: "c-host" }))
        yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows[1]?.state === "connected")
        const failed = yield* Effect.flip(
          coordinator(a.raw.Spawn({ machine: "mc", prompt: "x", harness: "pi", callerEnv: { TERM_PANE: "p1" } })),
        )
        assert.strictEqual(failed._tag, "NoRuntime")
        assert.include(failed.message, 'the runtime "term" is not loaded')
        assert.include(failed.message, (yield* c.run(VibestdIdentity)).name)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("the refused flags, an unknown machine and a machine that is not connected fail at once", () =>
    Effect.gen(function* () {
      const { net, a, coordinator } = yield* twoMachines()
      const run = (more: object) =>
        Effect.flip(coordinator(a.raw.Spawn({ machine: "mb", prompt: "x", callerEnv: {}, ...more })))
      assert.include((yield* run({ env: { A: "1" } })).message, "--env is not sent to another machine")
      assert.include((yield* run({ archive: true })).message, "--archive-on-completion")
      assert.include((yield* run({ agent: "reviewer" })).message, "--agent is not sent to another machine")
      assert.include((yield* run({ runtimeSession: "s1" })).message, "--session is not sent to another machine")
      const reserved = yield* run({ agent: "main" })
      assert.strictEqual(reserved._tag, "Forbidden", "the reserved name is refused before the machine is asked")
      assert.include(reserved.message, "reserved for the main agent")
      assert.include((yield* run({ prompt: "x".repeat(PROMPT_MAX + 1) })).message, "at most 1048576 bytes (1 MiB)")
      const big = yield* run({ prompt: "x".repeat(PROMPT_MAX + 1) })
      assert.strictEqual(big._tag, "PromptTooLarge", "B's error comes through unchanged")
      const nosuch = yield* Effect.flip(coordinator(a.raw.Spawn({ machine: "nosuch", prompt: "x", callerEnv: {} })))
      assert.strictEqual(nosuch._tag, "UnknownMachine")
      assert.strictEqual(nosuch.message, 'unknown machine "nosuch"; machines: mb')
      const missing = yield* Effect.flip(coordinator(a.raw.Get({ id: "mb/deadbeef" })))
      assert.strictEqual(missing._tag, "NoSuchSession")
      assert.strictEqual(missing.message, "no session deadbeef", "B's error and message, no machine prefix")
      net.fail("b-host", 255, "ssh: connect to host b-host port 22: Connection refused")
      yield* net.cutAll("b-host")
      yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows[0]?.state === "unreachable")
      const down = yield* run({})
      assert.strictEqual(down._tag, "MachineUnavailable")
      assert.include(down.message, "mb is unreachable: ")
      assert.match(down.message, /closed|refused/)
      const forwarded = yield* Effect.flip(coordinator(a.raw.Get({ id: "mb/12345678" })))
      assert.strictEqual(forwarded._tag, "MachineUnavailable")
      assert.include(forwarded.message, "mb is unreachable")
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("a pipe cut after A's commit and before B got the ack gives one notice after reconnect", () =>
    Effect.gen(function* () {
      const cutOnce = { net: undefined as Net | undefined, done: false }
      const { net, a, b, main, coordinator } = yield* twoMachines({
        a: {
          db: (db) => ({
            ...db,
            receivePeerItem: (item) =>
              db
                .receivePeerItem(item)
                .pipe(
                  Effect.tap(() =>
                    cutOnce.done || cutOnce.net === undefined
                      ? Effect.void
                      : Effect.sync(() => (cutOnce.done = true)).pipe(Effect.andThen(cutOnce.net.cutAll("b-host"))),
                  ),
                ),
          }),
        },
      })
      cutOnce.net = net
      const spawned = yield* coordinator(a.raw.Spawn({ machine: "mb", prompt: "x", callerEnv: {} }))
      yield* finish(b.db, onB(spawned.id), "once")
      yield* untilVirtual(b.run(outboxRows), (rows) => rows.length === 0)
      assert.isTrue(cutOnce.done)
      assert.lengthOf(yield* a.run(inboxOf(main)), 1)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("results written while A is away, or after machine rm, arrive once when A connects again", () =>
    Effect.gen(function* () {
      const { net, a, b, main, coordinator } = yield* twoMachines()
      const first = yield* coordinator(a.raw.Spawn({ machine: "mb", prompt: "one", callerEnv: {} }))
      const second = yield* coordinator(a.raw.Spawn({ machine: "mb", prompt: "two", callerEnv: {} }))
      net.fail("b-host", 255, "ssh: connect to host b-host port 22: Connection refused")
      yield* net.cutAll("b-host")
      yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows[0]?.state === "unreachable")
      yield* finish(b.db, onB(first.id), "while away")
      net.route("b-host", b.layout.socket)
      yield* untilVirtual(a.run(inboxOf(main)), (rows) => rows.length === 1)
      yield* a.cli(a.raw["Machine.Remove"]({ name: "mb" }))
      yield* finish(b.db, onB(second.id), "after rm")
      assert.lengthOf(yield* b.run(outboxRows), 1, "it waits on B")
      yield* a.cli(a.raw["Machine.Add"]({ name: "mb2", target: "b-host" }))
      const rows = yield* until(a.run(inboxOf(main)), (r) => r.length === 2)
      assert.strictEqual(rows[1]!.content, `mb2/${onB(second.id).slice(0, 8)}: after rm`)
      yield* until(b.run(outboxRows), (r) => r.length === 0)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "a silent connection is dropped by keepalive: pings go out every 5 s and 10 s without a frame ends it",
    () =>
      Effect.gen(function* () {
        const { net, a } = yield* twoMachines()
        net.fail("b-host", 255, "ssh: connect to host b-host port 22: Connection timed out")
        yield* Effect.forEach(net.routes.get("b-host")!.pipes, (p) => p.hold, { discard: true })
        const held = yield* Clock.currentTimeMillis
        yield* TestClock.adjust("14 seconds")
        yield* yieldToIo
        assert.strictEqual((yield* a.cli(a.raw["Machine.List"]()))[0]?.state, "connected", "not dropped before 15 s")
        const [down] = yield* untilVirtual(a.cli(a.raw["Machine.List"]()), (rows) => rows[0]?.state === "unreachable")
        assert.include(down!.reason ?? "", "stopped answering")
        const after = (yield* Clock.currentTimeMillis) - held
        assert.isAtLeast(after, 15_000)
        assert.isBelow(after, 17_000)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
