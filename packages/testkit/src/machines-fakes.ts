import stream from "node:stream"

import { cliHeaders, connect, withHeaders } from "@vibest/client/client"
import { stdioSocket } from "@vibest/client/pipe"
import type { SocketConnector } from "@vibest/client/socket-connector"
import { Db } from "@vibest/core/database/db"
import { senderOfRow, type SenderSql } from "@vibest/core/database/db-rows"
import { Identity } from "@vibest/core/identity"
import { Project } from "@vibest/core/project"
import type { SpawnInput, Session } from "@vibest/core/session"
import * as Platform from "@vibest/platform-bun/bun"
import { servePipe } from "@vibest/platform-bun/pipe-server"
import { remoteHeaders, sessionHeaders } from "@vibest/protocol/protocol"
import { Sender } from "@vibest/schema/event"
import { randomId } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import type { Machines } from "@vibest/server/machine/machines"
import * as Server from "@vibest/server/server"
import { Cause, Clock, Deferred, Effect, Exit, Layer, Option, Predicate, Schema, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import { SqlClient } from "effect/sql"

import { FakeGit, tempDirectory, testLayer, type TestOptions, until } from "./fakes.ts"

export const served = (options?: TestOptions) =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.httpServer(layout.socket)))),
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

export class Net {
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

  transport(_dial?: SocketConnector.Interface): Machines.MachineTransport["Service"] {
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

        const clientToServer = new stream.PassThrough()
        const serverToClient = new stream.PassThrough()
        yield* Effect.forkScoped(
          servePipe(route.socket, { stdin: clientToServer, stdout: serverToClient }).pipe(Effect.ignore),
        )

        const inner = yield* stdioSocket({
          readable: stream.Readable.toWeb(serverToClient) as ReadableStream<Uint8Array>,
          writable: stream.Writable.toWeb(clientToServer) as WritableStream<Uint8Array>,
        })

        const cut = yield* Deferred.make<void>()

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            Deferred.doneUnsafe(cut, Exit.void)
            clientToServer.destroy()
            serverToClient.destroy()
          }),
        )

        const held = { on: false }
        route.pipes.push({
          cut: Deferred.succeed(cut, undefined).pipe(Effect.asVoid),
          hold: Effect.sync(() => (held.on = true)),
        })
        const failOnCut = Deferred.await(cut).pipe(Effect.andThen(Effect.fail(closed())))

        const socket = Socket.make({
          reader: Effect.map(inner.reader, (r) => ({
            pull: Effect.suspend(() =>
              held.on
                ? Effect.never
                : r.pull.pipe(Effect.flatMap((chunk) => (held.on ? Effect.never : Effect.succeed(chunk)))),
            ).pipe(Effect.raceFirst(failOnCut)),
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

export const peerSession = {
  agent: "general",
  harnessId: "pi" as const,
  provider: null,
  model: null,
  harnessSessionId: null,
  runtime: "fake",
  terminal: null,
  status: "unknown" as const,
  startedAt: null,
  exitedAt: null,
  executionState: "none" as const,
  executionPromptedAt: 0,
}

export const fakeSpawns =
  (spawns: Array<SpawnInput>, terminal: (input: SpawnInput, id: string) => string = () => "") =>
  (sessions: Session.Interface, db: Db.Interface) => ({
    ...sessions,
    spawn: (input: SpawnInput) =>
      Effect.gen(function* () {
        spawns.push(input)
        const id = randomId()
        const at = yield* Clock.currentTimeMillis
        const t = terminal(input, id)

        const inserted = yield* db.session.insertSession(
          {
            ...peerSession,
            id,
            name: input.name,
            createdAt: at,
            lastActive: at,
            runtime: input.runtime ?? peerSession.runtime,
            terminal: t === "" ? null : { id: t },
          },
          input.projectId,
          {
            cwd: input.root,
            task: input.prompt,
            parentSessionId: input.parentSessionId,
            request: input.request,
            origin: input.origin,
          },
        )

        const before = Predicate.isObject(inserted) && "id" in inserted ? inserted : undefined

        return {
          id: before?.id ?? id,
          harness: "pi" as const,
          provider: undefined,
          model: undefined,
          runtime: input.runtime ?? peerSession.runtime,
          decidedBy: {},
          trace: [],
        }
      }),
  })

export const A_ENTRY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
export const REMOTE = "git@example.com:o/r.git"
export const COMMIT = "0123456789abcdef0123456789abcdef01234567"
export const REPOSITORY = { origin: REMOTE, head: COMMIT, commits: [COMMIT] }

export const repoStack = (net?: Net, options: TestOptions = {}, remote = REMOTE) =>
  Effect.gen(function* () {
    const spawns: Array<SpawnInput> = []
    const transport = net === undefined ? {} : { transport: net.transport() }

    const context = yield* Layer.build(
      served({ ...transport, ...options, sessions: options.sessions ?? fakeSpawns(spawns) }),
    )

    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context)
    const layout = yield* run(Layout)
    const db = yield* run(Db.Service)
    const directory = yield* tempDirectory("vibest-b-checkout-")
    yield* (yield* run(FakeGit)).repository(directory, { ...REPOSITORY, origin: remote })
    const project = yield* db.project.createProject(directory, [{ path: directory, remote }])
    const raw = yield* connect(layout.socket)
    const cli = <A, E>(effect: Effect.Effect<A, E>) => withHeaders(effect, cliHeaders(layout.home))

    const as = (remote: string, aProject: string, by = A_ENTRY) =>
      Effect.gen(function* () {
        yield* withHeaders(
          raw["server.remote"]["remote.hello"]({
            payload: { id: remote, name: `a-${remote.slice(0, 4)}`, callsMe: "mb" },
          }),
          remoteHeaders(remote),
        )

        const call = <A, E>(effect: Effect.Effect<A, E>) => withHeaders(effect, remoteHeaders(remote, aProject, by))

        return Object.assign(call, {
          outbox: Stream.unwrap(
            withHeaders(raw["server.remote"]["remote.outbox"](), remoteHeaders(remote, aProject, by)),
          ),
        })
      })

    const spawn = (call: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>, request = randomId()) =>
      call(
        raw["server.remote"]["remote.spawn"]({
          payload: { agent: "general", repository: REMOTE, commit: COMMIT, prompt: "do it", request },
        }),
      )

    return { run, db, raw, cli, as, spawn, spawns, directory, project, layout, id: (yield* run(Identity.Service)).id }
  })

export const entryOn = (stack: Effect.Success<ReturnType<typeof repoStack>>) =>
  Effect.gen(function* () {
    const started = yield* stack.db.session.startRoot(
      stack.project,
      "pi",
      false,
      {
        runtime: "fake",
        target: { id: "main-pane" },
      },
      { agent: "coordinator" },
    )

    const asEntry = <A, E>(effect: Effect.Effect<A, E>) =>
      withHeaders(
        effect,
        sessionHeaders({ sessionId: started.sessionId, projectId: stack.project, repositoryRoot: stack.directory }),
      )

    return { entryId: started.sessionId, asEntry }
  })

export const onB = (address: string) => address.slice(address.indexOf("/") + 1)

export const twoMachines = (options: { readonly a?: TestOptions; readonly b?: TestOptions } = {}) =>
  Effect.gen(function* () {
    const net = new Net()
    const a = yield* repoStack(net, options.a)
    const b = yield* repoStack(net, options.b)
    net.route("b-host", b.layout.socket)
    const { entryId, asEntry } = yield* entryOn(a)
    yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mb", target: "b-host" } }))
    yield* until(a.cli(a.raw["server.machine"]["machine.list"]({})), (rows) => rows[0]?.state === "connected")

    return { net, a, b, entryId, asEntry }
  })

const decodeSender = Schema.decodeUnknownSync(Sender)

export const sendersTo = (recipient: string, which: "task" | "send" | "notice" = "send") =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const task = sql`EXISTS (SELECT 1 FROM session s WHERE s.id = inbox.recipient_session_id AND s.message_id = inbox.id)`
    const notice = sql`sender_type = 'vibest'`
    const send = sql`sender_type != 'vibest' AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = inbox.recipient_session_id AND s.message_id = inbox.id)`
    let where = send

    if (which === "task") where = task

    if (which === "notice") where = notice

    return sql<SenderSql>`SELECT sender_type, sender_session_id, sender_agent, sender_title, sender_machine,
        sender_plugin FROM inbox WHERE recipient_session_id = ${recipient} AND ${where} ORDER BY id`
  }).pipe(Effect.map((rows) => rows.map((row) => decodeSender(senderOfRow(row)))))

export const inboxOf = (recipient: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{
        content: string
        senderType: string
      }>`SELECT content, sender_type FROM inbox WHERE recipient_session_id = ${recipient} ORDER BY id`,
  )

export const outboxRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{
      remoteId: string
      sessionId: string
    }>`SELECT o.remote_id, o.session_id FROM outbox o LEFT JOIN session s ON s.id = o.session_id
        WHERE o.acked_at IS NULL AND s.ended_at IS NULL ORDER BY o.created_at`,
)

export const remotes = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ id: string; name: string }>`SELECT id, name FROM remote ORDER BY id`,
)

export const failureTag = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => "defect",
        onSome: (e) => (e as { readonly _tag: string })._tag,
      })
    : "success"
