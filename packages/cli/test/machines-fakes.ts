import { cliHeaders, connect } from "@vibest/client/client"
import { SocketConnector } from "@vibest/client/socket-connector"
import { Db } from "@vibest/core/db"
import { VibestdIdentity } from "@vibest/core/identity"
import type { MachineTransport } from "@vibest/core/machines"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import type { SpawnInput, Sessions } from "@vibest/core/sessions"
import { peerHeaders, sessionHeaders } from "@vibest/protocol/protocol"
import { randomId } from "@vibest/schema/id"
import * as Server from "@vibest/server/server"
import { Clock, Deferred, Effect, Layer } from "effect"
import { RpcClient } from "effect/rpc"
import * as Socket from "effect/socket/Socket"

import * as Platform from "#platform"

import { FakeGit, tempDirectory, testLayer, type TestOptions, until } from "./fakes.ts"

export const served = (options?: TestOptions) =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
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

export const peerSession = {
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
  executionState: "none" as const,
  executionPromptedAt: 0,
}

export const fakeSpawns =
  (spawns: Array<SpawnInput>, terminal: (input: SpawnInput, id: string) => string = () => "") =>
  (sessions: Sessions["Service"], db: Db["Service"]) => ({
    ...sessions,
    spawn: (input: SpawnInput) =>
      Effect.gen(function* () {
        spawns.push(input)
        const id = randomId()
        const at = yield* Clock.currentTimeMillis
        const inserted = yield* db.insertSession(
          {
            ...peerSession,
            id,
            name: input.name,
            createdAt: at,
            lastActive: at,
            runtime: input.runtime ?? peerSession.runtime,
            address: { machine: "local", id: terminal(input, id) },
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
        const before = typeof inserted === "object" ? inserted : undefined
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
    const transport = net === undefined ? {} : { transport: net.transport(yield* SocketConnector) }
    const context = yield* Layer.build(
      served({ ...transport, ...options, sessions: options.sessions ?? fakeSpawns(spawns) }),
    )
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context)
    const layout = yield* run(Layout)
    const db = yield* run(Db)
    const directory = yield* tempDirectory("vibest-b-checkout-")
    yield* (yield* run(FakeGit)).repository(directory, { ...REPOSITORY, origin: remote })
    const project = yield* db.createProject(directory, [{ path: directory, remote }])
    const raw = yield* connect(layout.socket)
    const cli = <A, E>(effect: Effect.Effect<A, E>) => RpcClient.withHeaders(effect, cliHeaders(layout.home))
    const as = (peer: string, aProject: string, by = A_ENTRY) =>
      Effect.gen(function* () {
        yield* RpcClient.withHeaders(
          raw["Peer.Hello"]({ id: peer, name: `a-${peer.slice(0, 4)}`, callsMe: "mb" }),
          peerHeaders(peer),
        )
        const call = <A, E>(effect: Effect.Effect<A, E>) =>
          RpcClient.withHeaders(effect, peerHeaders(peer, aProject, by))
        return Object.assign(call, {
          outbox: raw["Peer.Outbox"](undefined, { headers: peerHeaders(peer, aProject, by) }),
        })
      })
    const spawn = (call: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>, request = randomId()) =>
      call(raw["Peer.Spawn"]({ agent: "general", repository: REMOTE, commit: COMMIT, prompt: "do it", request }))
    return { run, db, raw, cli, as, spawn, spawns, directory, project, layout, id: (yield* run(VibestdIdentity)).id }
  })

export const entryOn = (stack: Effect.Success<ReturnType<typeof repoStack>>) =>
  Effect.gen(function* () {
    const started = yield* stack.db.startEntry(
      stack.project,
      "pi",
      false,
      {
        runtime: "fake",
        address: { machine: "local", id: "main-pane" },
      },
      { agent: "coordinator" },
    )
    const asEntry = <A, E>(effect: Effect.Effect<A, E>) =>
      RpcClient.withHeaders(
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
    yield* a.cli(a.raw["Machine.Add"]({ name: "mb", target: "b-host" }))
    yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows[0]?.state === "connected")
    return { net, a, b, entryId, asEntry }
  })
