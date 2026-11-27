import stream from "node:stream"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { connectPipe, stdioSocket } from "@vibest/client/pipe"
import { withHeaders } from "@vibest/client/unix-http"
import { Identity } from "@vibest/core/identity"
import { InboxStore } from "@vibest/core/inbox/store"
import { RemoteStore } from "@vibest/core/remote/store"
import { SessionStore } from "@vibest/core/session/store"
import { servePipe } from "@vibest/platform-bun/pipe-server"
import { REMOTE_BY_USER, remoteHeaders } from "@vibest/protocol/protocol"
import { randomId } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import { OUTBOX_ITEM_MAX, type OutboxItem, PROMPT_MAX } from "@vibest/schema/machine"
import { REMOTE_LINE, RETRY_FIRST, sshArgv, targetProblem, nameProblem } from "@vibest/server/machine/machines"
import { runVibest, tempDirectory, until, untilVirtual, yieldToIo } from "@vibest/testkit/fakes"
import {
  A_ENTRY,
  COMMIT,
  failureTag,
  Net,
  outboxRows,
  peerSession,
  REMOTE,
  remotes,
  repoStack,
  sendersTo,
  served,
} from "@vibest/testkit/machines-fakes"
import { Cause, type Context, Duration, Effect, Exit, Fiber, Layer, Option, Queue, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { teardown } from "../src/cli.ts"
import { pipeStdio } from "../src/connect.ts"

type Stack = Context.Context<Layer.Success<ReturnType<typeof served>>>

const stack = (net: Net) =>
  Effect.gen(function* () {
    const context: Stack = yield* Layer.build(served({ transport: net.transport() }))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context)
    const layout = yield* run(Layout)
    const raw = yield* connect(layout.socket)
    const cli = <A, E>(effect: Effect.Effect<A, E>) => withHeaders(effect, cliHeaders(layout.home))

    return { context, run, layout, raw, cli, id: (yield* run(Identity.Service)).id }
  })

const pipeToSocket = (path: string) =>
  Effect.gen(function* () {
    const c2s = new stream.PassThrough()
    const s2c = new stream.PassThrough()
    yield* servePipe(path, { stdin: c2s, stdout: s2c }).pipe(Effect.ignore, Effect.forkScoped)

    const sock = yield* stdioSocket({
      writable: stream.Writable.toWeb(c2s) as WritableStream<Uint8Array>,
      readable: stream.Readable.toWeb(s2c) as ReadableStream<Uint8Array>,
    })

    return yield* connectPipe(sock)
  })

describe("the remote caller", () => {
  it.effect("Remote.Hello over a stdin and stdout pipe records the remote; only Hello is allowed before it", () =>
    Effect.gen(function* () {
      const layout = yield* Layout
      const self = yield* Identity.Service
      const client = yield* pipeToSocket(layout.socket)
      const remote = randomId()
      const as = <A, E, R>(effect: Effect.Effect<A, E, R>) => withHeaders(effect, remoteHeaders(remote))
      assert.strictEqual(
        failureTag(yield* Effect.exit(as(client["server.session"]["session.list"]({ query: {} })))),
        "InvalidCaller",
        "no Hello yet",
      )

      const hello = yield* as(
        client["server.remote"]["remote.hello"]({ payload: { id: remote, name: "mac-mini", callsMe: "mb" } }),
      )

      assert.deepStrictEqual({ id: hello.id, name: hello.name }, { id: self.id, name: self.name })
      assert.deepStrictEqual(yield* remotes, [{ id: remote, name: "mac-mini" }])
      yield* as(client["server.remote"]["remote.hello"]({ payload: { id: remote, name: "mac-mini-2", callsMe: "mb" } }))
      assert.deepStrictEqual(yield* remotes, [{ id: remote, name: "mac-mini-2" }])

      const refused: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
        client["server.session"]["session.spawn"]({ payload: { agent: "general", prompt: "x", callerEnv: {} } }),
        client["server.session"]["session.claim"]({
          payload: { agent: "coordinator", fresh: false, terminal: { id: "t1" } },
        }),
        client["server.daemon"]["daemon.stop"]({ payload: { instance: "x" } }),
      ]

      for (const call of refused) assert.strictEqual(failureTag(yield* Effect.exit(as(call))), "InvalidCaller")

      const other = yield* Effect.exit(
        withHeaders(
          client["server.remote"]["remote.hello"]({ payload: { id: remote, name: "x", callsMe: "y" } }),
          remoteHeaders(randomId()),
        ),
      )

      assert.strictEqual(failureTag(other), "Forbidden", "Hello names the caller")
    }).pipe(Effect.scoped, Effect.provide(served())),
  )

  it.effect("a Hello from this vibestd's own id records no remote", () =>
    Effect.gen(function* () {
      const layout = yield* Layout
      const self = yield* Identity.Service
      const client = yield* connect(layout.socket)

      const hello = yield* withHeaders(
        client["server.remote"]["remote.hello"]({ payload: { id: self.id, name: "me", callsMe: "loop" } }),
        remoteHeaders(self.id),
      )

      assert.strictEqual(hello.id, self.id)
      assert.deepStrictEqual(yield* remotes, [])
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

        const added = yield* a.cli(
          a.raw["server.machine"]["machine.add"]({ payload: { name: "mb", target: "b-host" } }),
        )

        assert.strictEqual(added.id, b.id)
        assert.strictEqual(added.vibestd, "test-host")
        assert.include(net.argv[0]!.join(" "), "BatchMode=yes")

        const [listed] = yield* until(
          a.cli(a.raw["server.machine"]["machine.list"]({})),
          (rows) => rows[0]?.state === "connected",
        )

        assert.strictEqual(listed!.id, b.id)
        assert.strictEqual(listed!.vibestd, "test-host")
        assert.lengthOf(net.argv, 1, "add dials once and keeps that connection")
        assert.deepStrictEqual(yield* b.run(remotes), [{ id: a.id, name: "test-host" }])

        const again = yield* Effect.flip(
          a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mb-again", target: "b-host" } })),
        )

        assert.strictEqual(again._tag, "AlreadyAdded")
        assert.include(again.message, "this is the vibestd already added as mb")
        assert.strictEqual((yield* a.cli(a.raw["server.machine"]["machine.list"]({}))).length, 1)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("harness list --machine asks B's vibestd; a peer is not passed on; an unknown machine is named", () =>
    Effect.gen(function* () {
      const net = new Net()
      const a = yield* stack(net)
      const b = yield* stack(net)
      net.route("b-host", b.layout.socket)
      yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mb", target: "b-host" } }))
      const there = yield* b.cli(b.raw["server.harness"]["harness.list"]({ query: {} }))
      assert.deepStrictEqual(yield* a.cli(a.raw["server.harness"]["harness.list"]({ query: { machine: "mb" } })), there)

      const second = yield* Effect.flip(
        withHeaders(b.raw["server.harness"]["harness.list"]({ query: { machine: "mc" } }), remoteHeaders(a.id)),
      )

      assert.strictEqual(second._tag, "Forbidden")

      const unknown = yield* Effect.flip(
        a.cli(a.raw["server.harness"]["harness.list"]({ query: { machine: "nosuch" } })),
      )

      assert.strictEqual(unknown._tag, "UnknownMachine")
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
          Effect.exit(a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mb", target: "b-host" } }))),
          Effect.exit(a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mb", target: "c-host" } }))),
        ],
        { concurrency: "unbounded" },
      )

      assert.deepStrictEqual(both.map(failureTag).sort(), ["MachineFailed", "success"])
      const lost = both.find(Exit.isFailure)!
      assert.include(String(Cause.squash(lost.cause)), "a machine named mb is already added")
      assert.lengthOf(yield* a.cli(a.raw["server.machine"]["machine.list"]({})), 1)
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
          const refused = yield* Effect.flip(
            a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "m", target } })),
          )

          assert.include(refused.message, message, target)
        }

        assert.deepStrictEqual(yield* a.cli(a.raw["server.machine"]["machine.list"]({})), [])

        const bad = yield* Effect.flip(
          a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "m", target: "root:pw@h" } })),
        )

        assert.include(bad.message, "password")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("a cut pipe goes unreachable with the reason and reconnects; connected_at and the peer row follow", () =>
    Effect.gen(function* () {
      const net = new Net()
      const a = yield* stack(net)
      const b = yield* stack(net)
      net.route("b-host", b.layout.socket)
      yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mb", target: "b-host" } }))

      const first = (yield* until(
        a.cli(a.raw["server.machine"]["machine.list"]({})),
        (r) => r[0]?.state === "connected",
      ))[0]!

      net.fail("b-host", 255, "ssh: connect to host b-host port 22: Connection refused")
      yield* net.cutAll("b-host")

      const down = (yield* until(
        a.cli(a.raw["server.machine"]["machine.list"]({})),
        (r) => r[0]?.state === "unreachable",
      ))[0]!

      assert.match(down.reason ?? "", /closed|refused/)
      net.route("b-host", b.layout.socket)

      const back = (yield* untilVirtual(
        a.cli(a.raw["server.machine"]["machine.list"]({})),
        (r) => r[0]?.state === "connected",
      ))[0]!

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
      yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mb", target: "b-host" } }))
      yield* until(a.cli(a.raw["server.machine"]["machine.list"]({})), (r) => r[0]?.state === "connected")
      const refused = (attempt: number) => `ssh: connect to host b-host port 22: Connection refused ${attempt}`
      net.fail("b-host", 255, refused(0))
      yield* net.cutAll("b-host")
      yield* until(a.cli(a.raw["server.machine"]["machine.list"]({})), (r) => r[0]?.state === "unreachable")
      let wait = Duration.toMillis(RETRY_FIRST)

      for (let attempt = 1; attempt <= 5; attempt++) {
        const dials = net.argv.length
        net.fail("b-host", 255, refused(attempt))
        yield* TestClock.adjust(wait - 1)
        yield* yieldToIo
        assert.strictEqual(net.argv.length, dials, `no dial before ${wait} ms`)
        yield* TestClock.adjust(1)
        yield* until(
          a.cli(a.raw["server.machine"]["machine.list"]({})),
          (r) => r[0]?.reason?.includes(refused(attempt)) === true,
        )
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
      yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mb", target: "b-host" } }))
      yield* until(a.cli(a.raw["server.machine"]["machine.list"]({})), (r) => r[0]?.state === "connected")
      net.route("b-host", c.layout.socket)
      yield* net.cutAll("b-host")

      const different = (yield* untilVirtual(
        a.cli(a.raw["server.machine"]["machine.list"]({})),
        (r) => r[0]?.state === "different",
      ))[0]!

      assert.include(different.reason ?? "", `mb now answers as a different vibestd (${c.id.slice(0, 8)})`)
      assert.strictEqual(different.id, b.id)
      const dials = net.argv.length
      yield* TestClock.adjust("10 minutes")
      yield* yieldToIo
      assert.strictEqual(net.argv.length, dials, "no retry")
      yield* a.cli(a.raw["server.machine"]["machine.remove"]({ params: { name: "mb" } }))

      const readded = yield* a.cli(
        a.raw["server.machine"]["machine.add"]({ payload: { name: "mb", target: "b-host" } }),
      )

      assert.strictEqual(readded.id, c.id)
      yield* until(
        a.cli(a.raw["server.machine"]["machine.list"]({})),
        (r) => r[0]?.state === "connected" && r[0].id === c.id,
      )
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})

const peerB = repoStack()

const finish = (
  db: {
    readonly session: SessionStore.Interface
    readonly inbox: InboxStore.Interface
    readonly remote: RemoteStore.Interface
  },
  session: string,
  message: string,
) => db.inbox.insertInbox({ sessionId: session, message })

describe("another machine's vibestd runs agents here", () => {
  it.effect("Remote.Spawn for an agent id machine B does not know is refused before any session is made", () =>
    Effect.gen(function* () {
      const b = yield* repoStack(undefined, { sessions: (sessions) => sessions })
      const call = yield* b.as(randomId(), "aproj")

      const refused = yield* Effect.flip(
        call(
          b.raw["server.remote"]["remote.spawn"]({
            payload: {
              agent: "reviewer",
              repository: REMOTE,
              commit: COMMIT,
              prompt: "x",
              request: randomId(),
            },
          }),
        ),
      )

      assert.strictEqual(refused._tag, "UnknownAgent")
      assert.include(refused.message, "reviewer")
      assert.deepStrictEqual((yield* call(b.raw["server.session"]["session.list"]({ query: {} }))).sessions, [])
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "Remote.Spawn records remote start and no parent; a retry finds it; no project or commit fails clearly",
    () =>
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
          (yield* call(b.raw["server.session"]["session.list"]({ query: {} }))).sessions.map((r) => r.id),
          [spawned.session],
        )
        assert.deepStrictEqual(
          yield* (yield* b.as(a, "other"))(b.raw["server.session"]["session.list"]({ query: {} })),
          { sessions: [], machines: [] },
          "another project of A sees none",
        )

        const row = yield* b.run(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) =>
              sql<{
                parent: string | null
                origin: string | null
              }>`SELECT parent_session_id AS parent, origin_session AS origin FROM session WHERE id = ${spawned.session}`,
          ),
        )

        assert.deepStrictEqual(row, [{ parent: null, origin: A_ENTRY }])

        const [task] = yield* b.run(sendersTo(spawned.session, "task"))

        assert.include(task, { type: "agent", session: A_ENTRY }, "the task is from A's entry session")
        assert.property(task, "machine")
        assert.strictEqual((yield* b.spawn(call, request)).session, spawned.session, "the same request")

        const noCommit = yield* Effect.flip(
          call(
            b.raw["server.remote"]["remote.spawn"]({
              payload: {
                agent: "general",
                repository: REMOTE,
                commit: "fedcba9",
                prompt: "x",
                request: randomId(),
              },
            }),
          ),
        )

        assert.strictEqual(noCommit._tag, "NoCommit")
        assert.include(noCommit.message, `does not have fedcba9: push it and fetch it there`)

        const noProject = yield* Effect.flip(
          call(
            b.raw["server.remote"]["remote.spawn"]({
              payload: {
                agent: "general",
                repository: "other",
                commit: COMMIT,
                prompt: "x",
                request: randomId(),
              },
            }),
          ),
        )

        assert.strictEqual(noProject._tag, "NoProject")
        assert.include(noProject.message, "vibest project add")
        const spawnsBefore = b.spawns.length

        const big = yield* Effect.flip(
          call(
            b.raw["server.remote"]["remote.spawn"]({
              payload: {
                agent: "general",
                repository: REMOTE,
                commit: COMMIT,
                prompt: "é".repeat(PROMPT_MAX / 2 + 1),
                request: randomId(),
              },
            }),
          ),
        )

        assert.strictEqual(big._tag, "PromptTooLarge")
        assert.include(big.message, "at most 1048576 bytes (1 MiB)")
        assert.lengthOf(b.spawns, spawnsBefore, "nothing was started for it")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("a result goes to the outbox, not to B's inbox delivery; the stream sends it and Ack settles it", () =>
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
      assert.isUndefined(result, "a forward writes no local delivery row")
      const item = yield* Queue.take(items)
      assert.deepStrictEqual(
        { session: item.session, recipient: item.recipient, kind: item.kind, content: item.content, cut: item.cut },
        { session, recipient: A_ENTRY, kind: "notice", content: "General Agent completed", cut: undefined },
      )
      assert.lengthOf(yield* b.run(outboxRows), 1)
      yield* call(b.raw["server.remote"]["remote.ack"]({ payload: { ids: [item.id] } }))
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
      yield* b.db.inbox.insertInbox({ sessionId: session, message: "two" })
      const first = yield* call.outbox.pipe(Stream.take(2), Stream.runCollect)
      assert.deepStrictEqual(
        first.map((i) => [i.kind, i.content]),
        [
          ["notice", "one"],
          ["notice", "two"],
        ],
      )
      yield* call(b.raw["server.remote"]["remote.ack"]({ payload: { ids: [first[0]!.id] } }))
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
      yield* a2(b.raw["server.session"]["session.list"]({ query: {} }))
      yield* yieldToIo
      yield* TestClock.adjust("300 millis")
      assert.isTrue(Option.isNone(yield* Fiber.join(waiting)), "a2's stream stays empty")
      assert.deepStrictEqual(
        (yield* a1(b.raw["server.session"]["session.list"]({ query: {} }))).sessions.map((r) => r.id),
        [session],
      )
      assert.deepStrictEqual(yield* a2(b.raw["server.session"]["session.list"]({ query: {} })), {
        sessions: [],
        machines: [],
      })

      for (const call of [
        b.raw["server.session"]["session.get"]({ params: { id: session }, query: {} }),
        b.raw["server.session"]["session.send"]({ params: { id: session }, payload: { message: "x" } }),
        b.raw["server.session"]["session.peek"]({ params: { id: session }, query: {} }),
        b.raw["server.session"]["session.interrupt"]({ params: { id: session }, query: {} }),
        b.raw["server.session"]["session.archive"]({ params: { id: session }, payload: {} }),
      ] as ReadonlyArray<Effect.Effect<unknown, unknown>>)
        assert.strictEqual(failureTag(yield* Effect.exit(a2(call))), "NoSuchSession")
      const sameProjectOtherPeer = yield* b.as(randomId(), "p1")
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            sameProjectOtherPeer(b.raw["server.session"]["session.get"]({ params: { id: session }, query: {} })),
          ),
        ),
        "NoSuchSession",
      )
      assert.strictEqual(
        (yield* a1(b.raw["server.session"]["session.get"]({ params: { id: session.slice(0, 8) }, query: {} }))).id,
        session,
      )
      yield* a1(b.raw["server.session"]["session.send"]({ params: { id: session }, payload: { message: "again" } }))
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("a forwarded call names who made it: a call without that, or a Spawn for the user, is refused", () =>
    Effect.gen(function* () {
      const b = yield* peerB
      const a = randomId()
      const call = yield* b.as(a, "aproj")
      const { session } = yield* b.spawn(call)
      const get = b.raw["server.session"]["session.get"]({ params: { id: session }, query: {} })
      assert.strictEqual((yield* Effect.flip(withHeaders(get, remoteHeaders(a, "aproj"))))._tag, "InvalidCaller")
      assert.strictEqual(
        (yield* Effect.flip(withHeaders(get, remoteHeaders(a, "aproj", "somebody"))))._tag,
        "InvalidCaller",
      )
      const user = yield* b.as(a, "aproj", REMOTE_BY_USER)
      assert.strictEqual(
        (yield* user(b.raw["server.session"]["session.get"]({ params: { id: session }, query: {} }))).id,
        session,
        "the user may reach it",
      )
      const spawns = b.spawns.length
      const forUser = yield* Effect.flip(b.spawn(user))
      assert.strictEqual(forUser._tag, "Forbidden")
      assert.lengthOf(b.spawns, spawns)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "a session reaches only what it started on B and its messages carry its address; the user reaches all",
    () =>
      Effect.gen(function* () {
        const b = yield* peerB
        const a = randomId()
        const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        const x = yield* b.as(a, "aproj")
        const z = yield* b.as(a, "aproj", other)
        const user = yield* b.as(a, "aproj", REMOTE_BY_USER)
        const { session } = yield* b.spawn(x)
        assert.deepStrictEqual(
          (yield* z(b.raw["server.session"]["session.list"]({ query: {} }))).sessions.map((r) => r.id),
          [],
        )
        assert.deepStrictEqual(
          (yield* user(b.raw["server.session"]["session.list"]({ query: {} }))).sessions.map((r) => r.id),
          [session],
        )

        for (const call of [
          b.raw["server.session"]["session.get"]({ params: { id: session }, query: {} }),
          b.raw["server.session"]["session.send"]({ params: { id: session }, payload: { message: "pretending" } }),
          b.raw["server.session"]["session.peek"]({ params: { id: session }, query: {} }),
          b.raw["server.session"]["session.interrupt"]({ params: { id: session }, query: {} }),
          b.raw["server.session"]["session.archive"]({ params: { id: session }, payload: {} }),
        ] as ReadonlyArray<Effect.Effect<unknown, unknown>>)
          assert.strictEqual(failureTag(yield* Effect.exit(z(call))), "NoSuchSession")
        yield* b.db.remote.addMachine({ name: "my-workstation", target: "a-host", remoteId: a })
        const from = { session: A_ENTRY, agent: "coordinator", title: "Plan" }
        yield* x(
          b.raw["server.session"]["session.send"]({ params: { id: session }, payload: { message: "from x", from } }),
        )
        yield* user(
          b.raw["server.session"]["session.send"]({ params: { id: session }, payload: { message: "from the user" } }),
        )

        const sent = yield* b.run(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) =>
              sql<{ content: string }>`SELECT content FROM inbox i WHERE i.sender_type != 'vibest'
                AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = i.recipient_session_id AND s.message_id = i.id)
                ORDER BY i.id`,
          ),
        )

        assert.include(sent[0]!.content, `<session-id>${A_ENTRY.slice(0, 8)}</session-id>`)
        assert.include(sent[0]!.content, "<machine>my-workstation</machine>")
        assert.strictEqual(sent[1]!.content, "from the user")
        assert.deepStrictEqual(yield* b.run(sendersTo(session)), [
          { type: "agent", ...from, machine: "my-workstation" },
          { type: "user" },
        ])
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("a forwarded session sends only to what it started and manages the nearest living ones below it", () =>
    Effect.gen(function* () {
      const b = yield* peerB
      const a = randomId()
      const x = yield* b.as(a, "aproj")
      const { session } = yield* b.spawn(x)
      const grandchild = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      yield* b.db.session.insertSession(
        { ...peerSession, id: grandchild, name: "grand", createdAt: 1, lastActive: 1 },
        b.project,
        { parentSessionId: session },
      )
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            x(
              b.raw["server.session"]["session.send"]({
                params: { id: grandchild },
                payload: { message: "skipping a level" },
              }),
            ),
          ),
        ),
        "Forbidden",
      )
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            x(b.raw["server.session"]["session.interrupt"]({ params: { id: grandchild }, query: {} })),
          ),
        ),
        "Forbidden",
        "its parent is alive and manages it",
      )
      yield* b.db.session.archive(session)
      assert.strictEqual(
        failureTag(
          yield* Effect.exit(
            x(
              b.raw["server.session"]["session.send"]({
                params: { id: grandchild },
                payload: { message: "still not its child" },
              }),
            ),
          ),
        ),
        "Forbidden",
      )
      assert.notStrictEqual(
        failureTag(
          yield* Effect.exit(
            x(b.raw["server.session"]["session.interrupt"]({ params: { id: grandchild }, query: {} })),
          ),
        ),
        "Forbidden",
        "the nearest living manager is now the forwarded session",
      )
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
      yield* b.db.session.archive(archived.session)
      assert.deepStrictEqual(
        (yield* b.run(outboxRows)).map((r) => r.sessionId),
        [kept.session],
      )
      assert.strictEqual(
        failureTag(yield* Effect.exit(call(b.raw["server.machine"]["machine.list"]({})))),
        "InvalidCaller",
      )
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
