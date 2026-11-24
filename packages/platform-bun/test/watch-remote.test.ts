import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { SocketConnector } from "@vibest/client/socket-connector"
import { Db } from "@vibest/core/database/db"
import { Identity } from "@vibest/core/identity"
import { Plugin } from "@vibest/plugin/effect"
import { peerHeaders } from "@vibest/protocol/protocol"
import { PingResult, WatchEvent, WatchLagged } from "@vibest/protocol/rpc"
import { randomId } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import * as Listing from "@vibest/server/listing"
import { Effect, Layer, Predicate, Queue, Schema, Stream } from "effect"
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"

import * as Platform from "#platform"

import { makeRepository, projectOf, tempDirectory, until, untilVirtual } from "./lib/fakes.ts"
import { Net, served } from "./lib/machines-fakes.ts"

const makeStack = (net: Net, plugins: ReadonlyArray<Plugin.Plugin> = []) =>
  Effect.gen(function* () {
    const dial = yield* SocketConnector.Service
    const context = yield* Layer.build(served({ transport: net.transport(dial), plugins }))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context)
    const layout = yield* run(Layout)
    const raw = yield* connect(layout.socket)
    const cli = <A, E>(effect: Effect.Effect<A, E>) => RpcClient.withHeaders(effect, cliHeaders(layout.home))

    return { context, run, layout, raw, cli, id: (yield* run(Identity.Service)).id }
  })

const watchStream = (raw: Effect.Success<ReturnType<typeof connect>>, headers: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<WatchEvent>()
    yield* raw.Watch(undefined, { headers }).pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    )

    const next = <A extends WatchEvent>(match: (event: WatchEvent) => event is A) =>
      Effect.gen(function* () {
        for (;;) {
          const event = yield* Queue.take(events)

          if (match(event)) return event
        }
      }).pipe(Effect.timeout("10 seconds"), Effect.orDie)

    return { next }
  })

const isSnapshot = (e: WatchEvent): e is Extract<WatchEvent, { _tag: "Snapshot" }> => Predicate.isTagged(e, "Snapshot")

const FakePeerRpcs = RpcGroup.make(
  Rpc.make("Ping", { success: PingResult }),
  Rpc.make("Peer.Hello", {
    payload: { id: Schema.String, name: Schema.String, callsMe: Schema.String },
    success: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      version: Schema.String,
      runtimes: Schema.Array(Schema.Unknown),
    }),
  }),
  Rpc.make("Peer.Outbox", { success: Schema.Unknown, stream: true }),
  Rpc.make("Watch", { success: WatchEvent, error: WatchLagged, stream: true }),
)

const fakePeerSocket = (options: {
  readonly protocol: number
  readonly version: string
  readonly peerWatch?: boolean
  readonly id?: string
  readonly watch?: () => Stream.Stream<WatchEvent, WatchLagged>
}) =>
  Effect.gen(function* () {
    const dir = yield* tempDirectory("vibest-fake-peer-")
    const socket = `${dir}/peer.sock`
    const peerId = options.id ?? randomId()

    const handlers = FakePeerRpcs.toLayer({
      Ping: () =>
        Effect.succeed({
          version: options.version,
          protocol: options.protocol,
          capabilities: { ...(options.peerWatch === true && { peerWatch: true }) },
        }),
      "Peer.Hello": () => Effect.succeed({ id: peerId, name: "legacy-box", version: options.version, runtimes: [] }),
      "Peer.Outbox": () => Stream.never,
      Watch: () => (options.watch ? options.watch() : Stream.never),
    })

    const server = RpcServer.layer(FakePeerRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(RpcSerialization.layerNdJsonRpc()),
      Layer.provide(Platform.socketServer(socket)),
    )

    yield* Effect.forkScoped(Layer.launch(server))
    yield* until(
      Effect.flatMap(SocketConnector.Service, (dial) =>
        dial(socket).pipe(
          Effect.scoped,
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      ),
      (ready) => ready,
    )

    return { socket, peerId }
  })

describe("Watch with remote machines", () => {
  it.effect(
    "connected remote peer streams projects, sessions, and SessionEnded tagged with machine; mutual A<->B peer Watch stays local-only",
    () =>
      Effect.gen(function* () {
        const net = new Net()
        const a = yield* makeStack(net)
        const b = yield* makeStack(net)
        net.route("a-host", a.layout.socket)
        net.route("b-host", b.layout.socket)

        const bRepo = yield* b.run(makeRepository)
        const bProject = yield* b.run(projectOf(bRepo))

        const bEntry = yield* b.run(
          Effect.flatMap(Db.Service, (db) =>
            db.session.startEntry(
              bProject,
              "pi",
              false,
              { runtime: "herdr", address: { machine: "local", id: "b/p1" } },
              { agent: "coordinator", projectDirectory: bRepo },
            ),
          ),
        )

        yield* a.cli(a.raw["Machine.Add"]({ name: "box2", target: "b-host" }))
        yield* b.cli(b.raw["Machine.Add"]({ name: "box1", target: "a-host" }))

        yield* until(a.cli(a.raw.Watch(undefined).pipe(Stream.take(1), Stream.runCollect)), (chunk) => {
          const snap = chunk[0]

          return (
            snap !== undefined &&
            isSnapshot(snap) &&
            snap.machines.some((m) => m.name === "box2" && m.state === "connected") &&
            snap.projects.some((p) => p.id === bProject && p.machine === "box2") &&
            snap.sessions.some((s) => s.id === bEntry.sessionId && s.machine === "box2")
          )
        })

        const peerWatch = yield* watchStream(a.raw, peerHeaders(b.id))
        const peerSnap = yield* peerWatch.next(isSnapshot)
        assert.deepStrictEqual(peerSnap.machines, [])
        assert.isFalse(peerSnap.projects.some((p) => p.machine !== undefined))
        assert.isFalse(peerSnap.sessions.some((s) => s.machine !== undefined))

        const cliWatch = yield* watchStream(a.raw, cliHeaders(a.layout.home))
        const cliSnap = yield* cliWatch.next(isSnapshot)
        assert.isTrue(cliSnap.machines.some((m) => m.name === "box2" && m.state === "connected"))
        assert.isTrue(cliSnap.projects.some((p) => p.id === bProject && p.machine === "box2"))
        assert.isTrue(
          cliSnap.sessions.some((s) => s.id === bEntry.sessionId && s.projectId === bProject && s.machine === "box2"),
        )

        const bSub = randomId()
        yield* b.run(
          Effect.flatMap(Db.Service, (db) =>
            db.session.insertSession(
              {
                id: bSub,
                agent: "general",
                harnessId: "pi",
                harnessSessionId: null,
                name: "remote-worker",
                runtime: "herdr",
                address: { machine: "local", id: "b/p2" },
                status: "working",
                startedAt: 1000,
                createdAt: 1000,
                lastActive: 1000,
                executionState: "open",
                executionPromptedAt: 1000,
                provider: null,
                model: null,
                exitedAt: null,
              },
              bProject,
              { cwd: bRepo },
            ),
          ),
        )

        const added = yield* cliWatch.next(
          (e): e is Extract<WatchEvent, { _tag: "Session" }> =>
            Predicate.isTagged(e, "Session") && e.session.id === bSub && e.session.machine === "box2",
        )

        assert.strictEqual(added.session.projectId, bProject)

        yield* b.cli(b.raw.Remove({ id: bSub }))

        const ended = yield* cliWatch.next(
          (e): e is Extract<WatchEvent, { _tag: "SessionEnded" }> =>
            Predicate.isTagged(e, "SessionEnded") && e.id === bSub && e.machine === "box2",
        )

        assert.strictEqual(ended.projectId, bProject)

        yield* a.cli(a.raw["Machine.Remove"]({ name: "box2" }))

        const removed = yield* cliWatch.next(
          (e): e is Extract<WatchEvent, { _tag: "MachineRemoved" }> =>
            Predicate.isTagged(e, "MachineRemoved") && e.name === "box2",
        )

        assert.strictEqual(removed.name, "box2")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("offline or hung remote machine never blocks local Watch Snapshot", () =>
    Effect.gen(function* () {
      const net = new Net()
      const a = yield* makeStack(net)
      const peer = yield* fakePeerSocket({ protocol: PROTOCOL, version: "0.0.2-dev", peerWatch: true })
      net.route("offline-host", peer.socket)
      yield* a.cli(a.raw["Machine.Add"]({ name: "offline-box", target: "offline-host" }))

      net.fail("offline-host", 255, "ssh: connect to host offline-host port 22: Connection refused")
      yield* net.cutAll("offline-host")
      yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows[0]?.state === "unreachable")

      const startedAt = Date.now()
      const watch = yield* watchStream(a.raw, cliHeaders(a.layout.home))
      const snapshot = yield* watch.next(isSnapshot)
      const elapsedMs = Date.now() - startedAt

      assert.isBelow(elapsedMs, 2_000)
      const offline = snapshot.machines.find((m) => m.name === "offline-box")
      assert.isDefined(offline)
      assert.strictEqual(offline!.state, "unreachable")
      assert.isString(offline!.reason)
      assert.isNotEmpty(offline!.reason)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "incompatible remote machine (no peerWatch capability and protocol mismatch) reports state incompatible",
    () =>
      Effect.gen(function* () {
        const net = new Net()
        const a = yield* makeStack(net)

        const oldPeer = yield* fakePeerSocket({ protocol: PROTOCOL, version: "0.0.1-old", peerWatch: false })
        net.route("old-host", oldPeer.socket)
        yield* a.cli(a.raw["Machine.Add"]({ name: "old-box", target: "old-host" }))

        const watch = yield* watchStream(a.raw, cliHeaders(a.layout.home))
        const snap = yield* watch.next(isSnapshot)
        const oldBox = snap.machines.find((m) => m.name === "old-box")
        assert.isDefined(oldBox)
        assert.strictEqual(oldBox!.state, "incompatible")
        assert.include(oldBox!.reason ?? "", "run vibest update on old-box")

        const mismatchPeer = yield* fakePeerSocket({ protocol: PROTOCOL - 1, version: "0.0.0-mismatch" })
        net.route("old-host", mismatchPeer.socket)
        yield* net.cutAll("old-host")
        yield* untilVirtual(a.cli(a.raw["Machine.List"]()), (rows) => rows[0]?.state === "incompatible")

        const mismatched = yield* watch.next(
          (e): e is Extract<WatchEvent, { _tag: "Machine" }> =>
            Predicate.isTagged(e, "Machine") &&
            e.machine.name === "old-box" &&
            e.machine.state === "incompatible" &&
            (e.machine.reason ?? "").includes("protocol"),
        )

        assert.include(mismatched.machine.reason ?? "", "vibest update")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "remote Watch stream failing with WatchLagged automatically reconnects and refreshes Snapshot while connection stays open",
    () =>
      Effect.gen(function* () {
        const net = new Net()
        const a = yield* makeStack(net)
        const p1 = randomId()
        const s1 = randomId()
        const p2 = randomId()
        const s2 = randomId()
        let watchAttempts = 0

        const makeSession = (id: string, projectId: string, name: string) => ({
          id,
          name,
          agent: "general",
          harness: "pi",
          provider: null,
          model: null,
          status: "idle" as const,
          startedAt: 1000,
          exitedAt: null,
          executionState: "completed" as const,
          projectId,
          runtime: "herdr",
          address: { machine: "local", id: `r/${name}` },
          worktree: `/remote/${name}`,
          repositoryRoot: `/remote/${name}`,
          git: null,
          createdAt: 1000,
          lastActive: 1000,
          task: null,
          latest: null,
          parentId: null,
          finished: null,
        })

        const peer = yield* fakePeerSocket({
          protocol: PROTOCOL,
          version: "0.0.2-dev",
          peerWatch: true,
          watch: () => {
            watchAttempts++

            if (watchAttempts === 1)
              return Stream.concat(
                Stream.make(
                  Listing.WatchEvents.Snapshot({
                    projects: [
                      { id: p1, directory: "/remote/p1", entrySessionId: s1, activity: "idle", repositories: [] },
                    ],
                    sessions: [makeSession(s1, p1, "sess-1")],
                    machines: [],
                  }),
                ),
                Stream.fail(new WatchLagged({ message: "simulated lag on remote peer" })),
              )

            return Stream.concat(
              Stream.make(
                Listing.WatchEvents.Snapshot({
                  projects: [
                    { id: p2, directory: "/remote/p2", entrySessionId: s2, activity: "idle", repositories: [] },
                  ],
                  sessions: [makeSession(s2, p2, "sess-2")],
                  machines: [],
                }),
              ),
              Stream.never,
            )
          },
        })

        net.route("laggy-host", peer.socket)
        yield* a.cli(a.raw["Machine.Add"]({ name: "laggy-box", target: "laggy-host" }))

        yield* untilVirtual(a.cli(a.raw.Watch(undefined).pipe(Stream.take(1), Stream.runCollect)), (chunk) => {
          const snap = chunk[0]

          return (
            snap !== undefined &&
            isSnapshot(snap) &&
            snap.sessions.some((s) => s.id === s2 && s.machine === "laggy-box") &&
            !snap.sessions.some((s) => s.id === s1) &&
            snap.projects.some((p) => p.id === p2 && p.machine === "laggy-box")
          )
        })

        assert.isAtLeast(watchAttempts, 2)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "Get, List, and Watch all return identical hc addresses (bare default socket, secondary @socket, and remote machine/address)",
    () =>
      Effect.gen(function* () {
        const net = new Net()
        const unused = () => Effect.die(new Error("unused"))

        const fakeHcPlugin = (id: string, coreId: string, mirrorName?: string) =>
          Plugin.define({
            id: `fake-hc-${id}`,
            effect: (ctx) =>
              ctx.runtime.transform((editor) =>
                editor.add({
                  id: "hc",
                  status: () => Effect.succeed({ status: "online" as const }),
                  open: unused,
                  send: unused,
                  read: unused,
                  process: unused,
                  close: unused,
                  events: Stream.never,
                  link: () => Effect.succeed({ core: coreId }),
                  locate: (_peer, sessions) =>
                    Effect.succeed(
                      mirrorName === undefined
                        ? { missing: true, terminals: new Map() }
                        : {
                            missing: false,
                            as: mirrorName,
                            terminals: new Map(
                              [...sessions.entries()].map(([sessionId, remoteAddr]) => [
                                sessionId,
                                { id: `${mirrorName}/${remoteAddr}` },
                              ]),
                            ),
                          },
                    ),
                }),
              ),
          })

        const a = yield* makeStack(net, [fakeHcPlugin("a", "core-a", "mac-mini")])
        const b = yield* makeStack(net, [fakeHcPlugin("b", "core-b")])
        net.route("b-host", b.layout.socket)

        const aRepo = yield* a.run(makeRepository)
        const aProject = yield* a.run(projectOf(aRepo))

        const aEntry = yield* a.run(
          Effect.flatMap(Db.Service, (db) =>
            db.session.startEntry(
              aProject,
              "pi",
              false,
              { runtime: "hc", address: { machine: "local", id: "t1pk" } },
              { agent: "coordinator", projectDirectory: aRepo },
            ),
          ),
        )

        const aSecondaryId = randomId()
        yield* a.run(
          Effect.flatMap(Db.Service, (db) =>
            db.session.insertSession(
              {
                id: aSecondaryId,
                agent: "general",
                harnessId: "pi",
                harnessSessionId: null,
                name: "secondary-socket",
                runtime: "hc",
                address: { machine: "local", id: "t2@/other.sock" },
                status: "idle",
                startedAt: 1000,
                createdAt: 1000,
                lastActive: 1000,
                executionState: "completed",
                executionPromptedAt: 1000,
                provider: null,
                model: null,
                exitedAt: null,
              },
              aProject,
              { cwd: aRepo },
            ),
          ),
        )

        const bRepo = yield* b.run(makeRepository)
        const bProject = yield* b.run(projectOf(bRepo))

        const bRemoteId = randomId()
        yield* b.run(
          Effect.flatMap(Db.Service, (db) =>
            db.session.insertSession(
              {
                id: bRemoteId,
                agent: "general",
                harnessId: "pi",
                harnessSessionId: null,
                name: "remote-hc",
                runtime: "hc",
                address: { machine: "local", id: "t9pk" },
                status: "idle",
                startedAt: 1000,
                createdAt: 1000,
                lastActive: 1000,
                executionState: "completed",
                executionPromptedAt: 1000,
                provider: null,
                model: null,
                exitedAt: null,
              },
              bProject,
              { cwd: bRepo, origin: { peer: a.id, project: aProject, reportTo: aEntry.sessionId } },
            ),
          ),
        )

        yield* a.cli(a.raw["Machine.Add"]({ name: "mac-mini", target: "b-host" }))

        const snap = yield* until(a.cli(a.raw.Watch(undefined).pipe(Stream.take(1), Stream.runCollect)), (chunk) => {
          const first = chunk[0]

          return (
            first !== undefined &&
            isSnapshot(first) &&
            first.sessions.some((s) => s.id === bRemoteId && s.machine === "mac-mini")
          )
        })

        const snapshot = snap[0]!
        assert.isTrue(isSnapshot(snapshot))

        if (!isSnapshot(snapshot)) return

        const listed = yield* RpcClient.withHeaders(a.raw.List({}), cliHeaders(aRepo))
        const gotLocal = yield* a.cli(a.raw.Get({ id: aEntry.sessionId }))
        const gotSecondary = yield* a.cli(a.raw.Get({ id: aSecondaryId }))

        const gotRemote = yield* RpcClient.withHeaders(a.raw.Get({ id: `mac-mini/${bRemoteId}` }), cliHeaders(aRepo))

        const expectedLocal = { machine: "local", id: "t1pk" }
        const expectedSecondary = { machine: "local", id: "t2@/other.sock" }
        const expectedRemote = { machine: "local", id: "mac-mini/t9pk" }

        assert.deepStrictEqual(snapshot.sessions.find((s) => s.id === aEntry.sessionId)?.address, expectedLocal)
        assert.deepStrictEqual(listed.sessions.find((s) => s.id === aEntry.sessionId)?.address, expectedLocal)
        assert.deepStrictEqual(gotLocal?.address, expectedLocal)

        assert.deepStrictEqual(snapshot.sessions.find((s) => s.id === aSecondaryId)?.address, expectedSecondary)
        assert.deepStrictEqual(listed.sessions.find((s) => s.id === aSecondaryId)?.address, expectedSecondary)
        assert.deepStrictEqual(gotSecondary?.address, expectedSecondary)

        assert.deepStrictEqual(snapshot.sessions.find((s) => s.id === bRemoteId)?.address, expectedRemote)
        assert.deepStrictEqual(listed.sessions.find((s) => s.id === `mac-mini/${bRemoteId}`)?.address, expectedRemote)
        assert.deepStrictEqual(gotRemote?.address, expectedRemote)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
