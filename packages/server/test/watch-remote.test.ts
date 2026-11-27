import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { SocketConnector } from "@vibest/client/socket-connector"
import { withHeaders } from "@vibest/client/unix-http"
import { Identity } from "@vibest/core/identity"
import { SessionStore } from "@vibest/core/session/store"
import { Plugin } from "@vibest/plugin/effect"
import { WatchLagged } from "@vibest/protocol/errors"
import { DaemonGroup } from "@vibest/protocol/groups/daemon"
import { RemoteGroup } from "@vibest/protocol/groups/remote"
import { WatchGroup } from "@vibest/protocol/groups/watch"
import { AdmissionMiddleware, Caller, CallerMiddleware, ProtocolMiddleware } from "@vibest/protocol/middleware"
import { remoteHeaders } from "@vibest/protocol/protocol"
import type { WatchEvent } from "@vibest/protocol/schemas"
import { randomId } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import * as Listing from "@vibest/server/listing"
import { makeRepository, projectOf, tempDirectory, until, untilVirtual } from "@vibest/testkit/fakes"
import { Net, served } from "@vibest/testkit/machines-fakes"
import * as Platform from "@vibest/testkit/platform"
import { Effect, Layer, Predicate, Queue, Stream } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"

const makeStack = (net: Net, plugins: ReadonlyArray<Plugin.Plugin> = []) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(served({ transport: net.transport(), plugins }))
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context)
    const layout = yield* run(Layout)
    const raw = yield* connect(layout.socket)
    const cli = <A, E>(effect: Effect.Effect<A, E>) => withHeaders(effect, cliHeaders(layout.home))

    return { context, run, layout, raw, cli, id: (yield* run(Identity.Service)).id }
  })

const watchStream = (raw: Effect.Success<ReturnType<typeof connect>>, headers: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<WatchEvent>()
    yield* withHeaders(raw["server.watch"]["watch.subscribe"]({}), headers).pipe(
      Effect.flatMap((stream) => stream.pipe(Stream.runForEach((event) => Queue.offer(events, event)))),
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

const FakeRemoteApi = HttpApi.make("fake-remote").add(DaemonGroup).add(RemoteGroup).add(WatchGroup)

const fakeRemoteSocket = (options: {
  readonly protocol: number
  readonly version: string
  readonly remoteWatch?: boolean
  readonly id?: string
  readonly watch?: () => Stream.Stream<WatchEvent, WatchLagged>
}) =>
  Effect.gen(function* () {
    const dir = yield* tempDirectory("vibest-fake-remote-")
    const socket = `${dir}/remote.sock`
    const remoteId = options.id ?? randomId()

    const daemonHandlers = HttpApiBuilder.group(FakeRemoteApi, "server.daemon", (handlers) =>
      handlers
        .handle("daemon.ping", () =>
          Effect.succeed({
            version: options.version,
            protocol: options.protocol,
            capabilities: { ...(options.remoteWatch === true && { remoteWatch: true }) },
          }),
        )
        .handle("daemon.stop", () => Effect.die("unused"))
        .handle("daemon.handoff", () => Effect.die("unused"))
        .handle("daemon.concurrency", () => Effect.die("unused"))
        .handle("daemon.republish", () => Effect.die("unused")),
    )

    const remoteHandlers = HttpApiBuilder.group(FakeRemoteApi, "server.remote", (handlers) =>
      handlers
        .handle("remote.hello", () =>
          Effect.succeed({ id: remoteId, name: "legacy-box", version: options.version, runtimes: [] }),
        )
        .handle("remote.outbox", () => Effect.succeed(Stream.never))
        .handle("remote.ack", () => Effect.void)
        .handle("remote.spawn", () => Effect.die("unused"))
        .handle("remote.link", () => Effect.die("unused"))
        .handle("remote.unlink", () => Effect.die("unused")),
    )

    const watchHandlers = HttpApiBuilder.group(FakeRemoteApi, "server.watch", (handlers) =>
      handlers.handle("watch.subscribe", () => Effect.succeed(options.watch ? options.watch() : Stream.never)),
    )

    const noopMiddleware = Layer.mergeAll(
      Layer.succeed(AdmissionMiddleware, (httpEffect) => httpEffect),
      Layer.succeed(ProtocolMiddleware, (httpEffect) => httpEffect),
      Layer.succeed(CallerMiddleware, (httpEffect) =>
        Effect.provideService(httpEffect, Caller, { _tag: "Cli" as const, repositoryRoot: dir }),
      ),
    )

    const apiLayer = HttpApiBuilder.layer(FakeRemoteApi).pipe(
      Layer.provide(Layer.mergeAll(daemonHandlers, remoteHandlers, watchHandlers)),
      Layer.provide(noopMiddleware),
    )

    const server = HttpRouter.serve(apiLayer).pipe(
      Layer.provide(Platform.httpServer(socket)),
      Layer.provide(Layer.merge(HttpPlatform.layer, Etag.layerWeak)),
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

    return { socket, remoteId }
  })

describe("Watch with remote machines", () => {
  it.effect(
    "connected remote streams projects, sessions, and SessionEnded tagged with machine; mutual A<->B remote Watch stays local-only",
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
          Effect.flatMap(SessionStore.Service, (sessionStore) =>
            sessionStore.startRoot(
              bProject,
              "pi",
              false,
              { runtime: "herdr", target: { id: "b/p1" } },
              { agent: "coordinator", projectDirectory: bRepo },
            ),
          ),
        )

        yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "box2", target: "b-host" } }))
        yield* b.cli(b.raw["server.machine"]["machine.add"]({ payload: { name: "box1", target: "a-host" } }))

        yield* until(
          a.cli(
            a.raw["server.watch"]
              ["watch.subscribe"]({})
              .pipe(Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect))),
          ),
          (chunk) => {
            const snap = chunk[0]

            return (
              snap !== undefined &&
              isSnapshot(snap) &&
              snap.machines.some((m) => m.name === "box2" && m.state === "connected") &&
              snap.projects.some((p) => p.id === bProject && p.machine === "box2") &&
              snap.sessions.some((s) => s.id === bEntry.sessionId && s.machine === "box2")
            )
          },
        )

        const remoteWatch = yield* watchStream(a.raw, remoteHeaders(b.id))
        const remoteSnap = yield* remoteWatch.next(isSnapshot)
        assert.deepStrictEqual(remoteSnap.machines, [])
        assert.isFalse(remoteSnap.projects.some((p) => p.machine !== undefined))
        assert.isFalse(remoteSnap.sessions.some((s) => s.machine !== undefined))

        const cliWatch = yield* watchStream(a.raw, cliHeaders(a.layout.home))
        const cliSnap = yield* cliWatch.next(isSnapshot)
        assert.isTrue(cliSnap.machines.some((m) => m.name === "box2" && m.state === "connected"))
        assert.isTrue(cliSnap.projects.some((p) => p.id === bProject && p.machine === "box2"))
        assert.isTrue(
          cliSnap.sessions.some((s) => s.id === bEntry.sessionId && s.projectId === bProject && s.machine === "box2"),
        )

        const bSub = randomId()
        yield* b.run(
          Effect.flatMap(SessionStore.Service, (sessionStore) =>
            sessionStore.insertSession(
              {
                id: bSub,
                agent: "general",
                harnessId: "pi",
                harnessSessionId: null,
                name: "remote-worker",
                runtime: "herdr",
                terminal: { id: "b/p2" },
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

        yield* b.cli(b.raw["server.session"]["session.archive"]({ params: { id: bSub }, payload: {} }))

        const ended = yield* cliWatch.next(
          (e): e is Extract<WatchEvent, { _tag: "SessionEnded" }> =>
            Predicate.isTagged(e, "SessionEnded") && e.id === bSub && e.machine === "box2",
        )

        assert.strictEqual(ended.projectId, bProject)

        yield* a.cli(a.raw["server.machine"]["machine.remove"]({ params: { name: "box2" } }))

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
      const remote = yield* fakeRemoteSocket({ protocol: PROTOCOL, version: "0.0.2-dev", remoteWatch: true })
      net.route("offline-host", remote.socket)
      yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "offline-box", target: "offline-host" } }))

      net.fail("offline-host", 255, "ssh: connect to host offline-host port 22: Connection refused")
      yield* net.cutAll("offline-host")
      yield* until(a.cli(a.raw["server.machine"]["machine.list"]({})), (rows) => rows[0]?.state === "unreachable")

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
    "incompatible remote machine (no remoteWatch capability and protocol mismatch) reports state incompatible",
    () =>
      Effect.gen(function* () {
        const net = new Net()
        const a = yield* makeStack(net)

        const oldRemote = yield* fakeRemoteSocket({ protocol: PROTOCOL, version: "0.0.1-old", remoteWatch: false })
        net.route("old-host", oldRemote.socket)
        yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "old-box", target: "old-host" } }))

        const watch = yield* watchStream(a.raw, cliHeaders(a.layout.home))
        const snap = yield* watch.next(isSnapshot)
        const oldBox = snap.machines.find((m) => m.name === "old-box")
        assert.isDefined(oldBox)
        assert.strictEqual(oldBox!.state, "incompatible")
        assert.include(oldBox!.reason ?? "", "run vibest update on old-box")

        const mismatchRemote = yield* fakeRemoteSocket({ protocol: PROTOCOL - 1, version: "0.0.0-mismatch" })
        net.route("old-host", mismatchRemote.socket)
        yield* net.cutAll("old-host")
        yield* untilVirtual(
          a.cli(a.raw["server.machine"]["machine.list"]({})),
          (rows) => rows[0]?.state === "incompatible",
        )

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
          terminal: { runtime: "herdr", target: { id: `r/${name}` } },
          worktree: `/remote/${name}`,
          repositoryRoot: `/remote/${name}`,
          git: null,
          createdAt: 1000,
          lastActive: 1000,
          task: null,
          latest: null,
          parentId: null,
          finished: null,
          to: [],
        })

        const remote = yield* fakeRemoteSocket({
          protocol: PROTOCOL,
          version: "0.0.2-dev",
          remoteWatch: true,
          watch: () => {
            watchAttempts++

            if (watchAttempts === 1)
              return Stream.concat(
                Stream.make(
                  Listing.WatchEvents.Snapshot({
                    projects: [{ id: p1, directory: "/remote/p1", activity: "idle", repositories: [] }],
                    sessions: [makeSession(s1, p1, "sess-1")],
                    machines: [],
                  }),
                ),
                Stream.fail(new WatchLagged({ message: "simulated lag on remote" })),
              )

            return Stream.concat(
              Stream.make(
                Listing.WatchEvents.Snapshot({
                  projects: [{ id: p2, directory: "/remote/p2", activity: "idle", repositories: [] }],
                  sessions: [makeSession(s2, p2, "sess-2")],
                  machines: [],
                }),
              ),
              Stream.never,
            )
          },
        })

        net.route("laggy-host", remote.socket)
        yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "laggy-box", target: "laggy-host" } }))

        yield* untilVirtual(
          a.cli(
            a.raw["server.watch"]
              ["watch.subscribe"]({})
              .pipe(Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect))),
          ),
          (chunk) => {
            const snap = chunk[0]

            return (
              snap !== undefined &&
              isSnapshot(snap) &&
              snap.sessions.some((s) => s.id === s2 && s.machine === "laggy-box") &&
              !snap.sessions.some((s) => s.id === s1) &&
              snap.projects.some((p) => p.id === p2 && p.machine === "laggy-box")
            )
          },
        )

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
                              [...sessions.entries()].map(([sessionId, remoteTarget]) => [
                                sessionId,
                                { address: `${mirrorName}/${remoteTarget["address"]}` },
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
          Effect.flatMap(SessionStore.Service, (sessionStore) =>
            sessionStore.startRoot(
              aProject,
              "pi",
              false,
              { runtime: "hc", target: { address: "t1pk" } },
              { agent: "coordinator", projectDirectory: aRepo },
            ),
          ),
        )

        const aSecondaryId = randomId()
        yield* a.run(
          Effect.flatMap(SessionStore.Service, (sessionStore) =>
            sessionStore.insertSession(
              {
                id: aSecondaryId,
                agent: "general",
                harnessId: "pi",
                harnessSessionId: null,
                name: "secondary-socket",
                runtime: "hc",
                terminal: { address: "t2", socket: "/other.sock" },
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
          Effect.flatMap(SessionStore.Service, (sessionStore) =>
            sessionStore.insertSession(
              {
                id: bRemoteId,
                agent: "general",
                harnessId: "pi",
                harnessSessionId: null,
                name: "remote-hc",
                runtime: "hc",
                terminal: { address: "t9pk" },
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
              { cwd: bRepo, origin: { remote: a.id, project: aProject, reportTo: aEntry.sessionId } },
            ),
          ),
        )

        yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mac-mini", target: "b-host" } }))

        const snap = yield* until(
          a.cli(
            a.raw["server.watch"]
              ["watch.subscribe"]({})
              .pipe(Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect))),
          ),
          (chunk) => {
            const first = chunk[0]

            return (
              first !== undefined &&
              isSnapshot(first) &&
              first.sessions.some((s) => s.id === bRemoteId && s.machine === "mac-mini")
            )
          },
        )

        const snapshot = snap[0]!
        assert.isTrue(isSnapshot(snapshot))

        if (!isSnapshot(snapshot)) return

        const listed = yield* withHeaders(a.raw["server.session"]["session.list"]({ query: {} }), cliHeaders(aRepo))

        const gotLocal = yield* a.cli(
          a.raw["server.session"]["session.get"]({ params: { id: aEntry.sessionId }, query: {} }),
        )

        const gotSecondary = yield* a.cli(
          a.raw["server.session"]["session.get"]({ params: { id: aSecondaryId }, query: {} }),
        )

        const gotRemote = yield* withHeaders(
          a.raw["server.session"]["session.get"]({ params: { id: bRemoteId }, query: { machine: "mac-mini" } }),
          cliHeaders(aRepo),
        )

        const expectedLocal = { runtime: "hc", target: { address: "t1pk" } }
        const expectedSecondary = { runtime: "hc", target: { address: "t2", socket: "/other.sock" } }
        const expectedRemote = { runtime: "hc", target: { address: "mac-mini/t9pk" } }

        assert.deepStrictEqual(snapshot.sessions.find((s) => s.id === aEntry.sessionId)?.terminal, expectedLocal)
        assert.deepStrictEqual(listed.sessions.find((s) => s.id === aEntry.sessionId)?.terminal, expectedLocal)
        assert.deepStrictEqual(gotLocal?.terminal, expectedLocal)

        assert.deepStrictEqual(snapshot.sessions.find((s) => s.id === aSecondaryId)?.terminal, expectedSecondary)
        assert.deepStrictEqual(listed.sessions.find((s) => s.id === aSecondaryId)?.terminal, expectedSecondary)
        assert.deepStrictEqual(gotSecondary?.terminal, expectedSecondary)

        assert.deepStrictEqual(snapshot.sessions.find((s) => s.id === bRemoteId)?.terminal, expectedRemote)
        assert.deepStrictEqual(
          listed.sessions.find((s) => s.id === bRemoteId && s.machine === "mac-mini")?.terminal,
          expectedRemote,
        )
        assert.deepStrictEqual(gotRemote?.terminal, expectedRemote)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
