import { assert, describe, it } from "@effect/vitest"
import { withHeaders } from "@vibest/client/unix-http"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { EdgeDirected, EdgeMutual } from "@vibest/protocol/schemas"
import { FakeRuntime, until } from "@vibest/testkit/fakes"
import { inboxOf, outboxRows, peerSession, repoStack, twoMachines } from "@vibest/testkit/machines-fakes"
import * as Platform from "@vibest/testkit/platform"
import { Effect, Predicate, Stream } from "effect"

const asSession =
  (sessionId: string, projectId: string, repositoryRoot: string) =>
  <A, E>(effect: Effect.Effect<A, E>) =>
    withHeaders(effect, sessionHeaders({ sessionId, projectId, repositoryRoot }))

describe("cross-machine directed session graph", () => {
  it.effect("Session.Link/Unlink across local<->remote enforces directed sends and updates WatchSession.to", () =>
    Effect.gen(function* () {
      const { a, b, entryId, asEntry } = yield* twoMachines()

      const local = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", prompt: "local worker", callerEnv: {} },
        }),
      )

      const remote = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", machine: "mb", prompt: "remote worker", callerEnv: {} },
        }),
      )

      const remoteId = remote.id
      const remoteRef = { id: remote.id, machine: "mb" }
      const localRef = { id: local.id }
      const asLocal = asSession(local.id, a.project, a.directory)
      const asRemote = asSession(remoteId, b.project, b.directory)

      const blockedForward = yield* Effect.flip(
        asLocal(
          a.raw["server.session"]["session.send"]({
            params: { id: remoteRef.id },
            payload: { machine: remoteRef.machine, message: "blocked" },
          }),
        ),
      )

      assert.strictEqual(blockedForward._tag, "Forbidden")

      const blockedBack = yield* Effect.flip(
        asRemote(
          b.raw["server.session"]["session.send"]({ params: { id: local.id }, payload: { message: "blocked back" } }),
        ),
      )

      assert.strictEqual(blockedBack._tag, "NoSuchSession")

      yield* asEntry(
        a.raw["server.session"]["session.link"]({
          payload: { spec: EdgeDirected.make({ from: [localRef], to: [remoteRef] }) },
        }),
      )

      yield* asLocal(
        a.raw["server.session"]["session.send"]({
          params: { id: remoteRef.id },
          payload: { machine: remoteRef.machine, message: "local to remote" },
        }),
      )

      const bInbox = yield* until(b.run(inboxOf(remoteId)), (rows) =>
        rows.some((r) => r.content.includes("local to remote")),
      )

      assert.isTrue(bInbox.some((r) => r.content.includes("local to remote")))

      const stillBlockedBack = yield* Effect.flip(
        asRemote(
          b.raw["server.session"]["session.send"]({ params: { id: local.id }, payload: { message: "still blocked" } }),
        ),
      )

      assert.strictEqual(stillBlockedBack._tag, "NoSuchSession")

      yield* asEntry(
        a.raw["server.session"]["session.link"]({
          payload: { spec: EdgeDirected.make({ from: [remoteRef], to: [localRef] }) },
        }),
      )
      yield* asRemote(
        b.raw["server.session"]["session.send"]({
          params: { id: local.id.slice(0, 8) },
          payload: { message: "remote to local" },
        }),
      )

      const aInbox = yield* until(a.run(inboxOf(local.id)), (rows) =>
        rows.some((r) => r.content.includes("remote to local")),
      )

      assert.isTrue(aInbox.some((r) => r.content.includes("remote to local")))

      const [snap] = yield* until(
        a.cli(
          a.raw["server.watch"]
            ["watch.subscribe"]({})
            .pipe(Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect))),
        ),
        (chunk) => {
          const first = chunk[0]

          if (first === undefined || !Predicate.isTagged(first, "Snapshot")) return false
          const localRow = first.sessions.find((s) => s.id === local.id && s.machine === undefined)
          const remoteRow = first.sessions.find((s) => s.id === remoteId && s.machine === "mb")

          return (
            localRow !== undefined &&
            remoteRow !== undefined &&
            localRow.to.some((t) => t.id === remoteId && t.machine === "mb") &&
            remoteRow.to.some((t) => t.id === local.id) &&
            remoteRow.to.some((t) => t.id === entryId)
          )
        },
      )

      assert.isDefined(snap)

      yield* asEntry(
        a.raw["server.session"]["session.unlink"]({
          payload: { spec: EdgeMutual.make({ ids: [localRef, remoteRef] }) },
        }),
      )

      const afterUnlink = yield* Effect.flip(
        asLocal(
          a.raw["server.session"]["session.send"]({
            params: { id: remoteRef.id },
            payload: { machine: remoteRef.machine, message: "after unlink" },
          }),
        ),
      )

      assert.strictEqual(afterUnlink._tag, "Forbidden")
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("vibest run --machine with --with links the remote session with local siblings immediately", () =>
    Effect.gen(function* () {
      const { a, b, asEntry } = yield* twoMachines()

      const local = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", prompt: "local sibling", callerEnv: {} },
        }),
      )

      const remote = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: {
            agent: "general",
            machine: "mb",
            prompt: "remote sibling",
            with: [{ id: local.id }],
            callerEnv: {},
          },
        }),
      )

      const remoteId = remote.id
      const asLocal = asSession(local.id, a.project, a.directory)
      const asRemote = asSession(remoteId, b.project, b.directory)

      yield* asLocal(
        a.raw["server.session"]["session.send"]({
          params: { id: remoteId },
          payload: { machine: "mb", message: "ping via --with" },
        }),
      )
      yield* until(b.run(inboxOf(remoteId)), (rows) => rows.some((r) => r.content.includes("ping via --with")))

      yield* asRemote(
        b.raw["server.session"]["session.send"]({ params: { id: local.id }, payload: { message: "pong via --with" } }),
      )
      yield* until(a.run(inboxOf(local.id)), (rows) => rows.some((r) => r.content.includes("pong via --with")))
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("remote A -> remote B linked send relays through the initiator machine", () =>
    Effect.gen(function* () {
      const { net, a, b, asEntry } = yield* twoMachines()
      const c = yield* repoStack(net)
      net.route("c-host", c.layout.socket)
      yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mc", target: "c-host" } }))
      yield* until(a.cli(a.raw["server.machine"]["machine.list"]({})), (rows) =>
        rows.every((r) => r.state === "connected"),
      )

      const onMb = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", machine: "mb", prompt: "on b", callerEnv: {} },
        }),
      )

      const onMc = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", machine: "mc", prompt: "on c", callerEnv: {} },
        }),
      )

      const rbId = onMb.id
      const rcId = onMc.id

      yield* asEntry(
        a.raw["server.session"]["session.link"]({
          payload: {
            spec: EdgeDirected.make({ from: [{ id: rbId, machine: "mb" }], to: [{ id: rcId, machine: "mc" }] }),
          },
        }),
      )

      const asRb = asSession(rbId, b.project, b.directory)
      yield* asRb(
        b.raw["server.session"]["session.send"]({ params: { id: rcId }, payload: { message: "relay from mb to mc" } }),
      )

      const cInbox = yield* until(c.run(inboxOf(rcId)), (rows) =>
        rows.some((r) => r.content.includes("relay from mb to mc")),
      )

      assert.isTrue(cInbox.some((r) => r.content.includes("relay from mb to mc")))
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "edge expansion preserves deduplicated Mutual and non-self Directed pairs; invalid Spawn --machine --with leaks no remote session; short prefixes and archived remote targets are refused",
    () =>
      Effect.gen(function* () {
        const { a, b, asEntry } = yield* twoMachines()

        const s1 = yield* asEntry(
          a.raw["server.session"]["session.spawn"]({ payload: { agent: "general", prompt: "s1", callerEnv: {} } }),
        )

        const s2 = yield* asEntry(
          a.raw["server.session"]["session.spawn"]({ payload: { agent: "general", prompt: "s2", callerEnv: {} } }),
        )

        const r1 = { id: s1.id }
        const r2 = { id: s2.id }

        const mutualDup = yield* asEntry(
          a.raw["server.session"]["session.link"]({ payload: { spec: EdgeMutual.make({ ids: [r1, r2, r1] }) } }),
        )

        assert.deepStrictEqual(mutualDup.edges, [
          { from: r1, to: r2 },
          { from: r2, to: r1 },
        ])

        const mutualSelf = yield* Effect.flip(
          asEntry(a.raw["server.session"]["session.link"]({ payload: { spec: EdgeMutual.make({ ids: [r1, r1] }) } })),
        )

        assert.strictEqual(mutualSelf._tag, "Forbidden")
        assert.include(mutualSelf.message, "at least two distinct sessions")

        const directedOverlap = yield* asEntry(
          a.raw["server.session"]["session.link"]({
            payload: { spec: EdgeDirected.make({ from: [r1, r2], to: [r1, r2] }) },
          }),
        )

        assert.deepStrictEqual(directedOverlap.edges, [
          { from: r1, to: r2 },
          { from: r2, to: r1 },
        ])

        const invalidSpawn = yield* Effect.flip(
          asEntry(
            a.raw["server.session"]["session.spawn"]({
              payload: {
                agent: "general",
                machine: "mb",
                prompt: "should not start",
                with: [{ id: "00000000-0000-4000-8000-000000000000" }],
                callerEnv: {},
              },
            }),
          ),
        )

        assert.strictEqual(invalidSpawn._tag, "NoSuchSession")
        assert.lengthOf(b.spawns, 0)

        const remote = yield* asEntry(
          a.raw["server.session"]["session.spawn"]({
            payload: { agent: "general", machine: "mb", prompt: "r1", callerEnv: {} },
          }),
        )

        const remoteId = remote.id
        const remoteRef = { id: remoteId, machine: "mb" }
        yield* asEntry(
          a.raw["server.session"]["session.link"]({
            payload: { spec: EdgeDirected.make({ from: [r1], to: [remoteRef] }) },
          }),
        )

        const asS1 = asSession(s1.id, a.project, a.directory)

        const shortSend = yield* Effect.flip(
          asS1(
            a.raw["server.session"]["session.send"]({
              params: { id: remoteId.slice(0, 4) },
              payload: { machine: "mb", message: "short" },
            }),
          ),
        )

        assert.strictEqual(shortSend._tag, "Forbidden")

        const shortLink = yield* Effect.flip(
          asEntry(
            a.raw["server.session"]["session.link"]({
              payload: { spec: EdgeDirected.make({ from: [r1], to: [{ id: remoteId.slice(0, 4), machine: "mb" }] }) },
            }),
          ),
        )

        assert.strictEqual(shortLink._tag, "NoSuchSession")

        yield* b.db.session.endProcess(remoteId, "archived")
        yield* b.db.session.archive(remoteId)

        const archivedLink = yield* Effect.flip(
          asEntry(
            a.raw["server.session"]["session.link"]({
              payload: { spec: EdgeDirected.make({ from: [r1], to: [remoteRef] }) },
            }),
          ),
        )

        assert.strictEqual(archivedLink._tag, "NoSuchSession")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("initiator relay leaves outbox item unacked when target machine is unreachable", () =>
    Effect.gen(function* () {
      const { net, a, b, asEntry } = yield* twoMachines()
      const c = yield* repoStack(net)
      net.route("c-host", c.layout.socket)
      yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mc", target: "c-host" } }))
      yield* until(a.cli(a.raw["server.machine"]["machine.list"]({})), (rows) =>
        rows.every((r) => r.state === "connected"),
      )

      const onMb = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", machine: "mb", prompt: "on b", callerEnv: {} },
        }),
      )

      const onMc = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", machine: "mc", prompt: "on c", callerEnv: {} },
        }),
      )

      const rbId = onMb.id
      const rcId = onMc.id

      yield* asEntry(
        a.raw["server.session"]["session.link"]({
          payload: {
            spec: EdgeDirected.make({ from: [{ id: rbId, machine: "mb" }], to: [{ id: rcId, machine: "mc" }] }),
          },
        }),
      )

      net.fail("c-host", 255, "connection refused")
      yield* net.cutAll("c-host")
      yield* until(
        a.cli(a.raw["server.machine"]["machine.list"]({})),
        (rows) => rows.find((r) => r.name === "mc")?.state === "unreachable",
      )

      const asRb = asSession(rbId, b.project, b.directory)
      yield* asRb(
        b.raw["server.session"]["session.send"]({ params: { id: rcId }, payload: { message: "queued while mc down" } }),
      )

      const pending = yield* until(b.run(outboxRows), (rows) => rows.length === 1)
      assert.lengthOf(pending, 1)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "unqualified remote prefix resolution works in Session.Link and Spawn --with, surfaces remote linkedTargets, and completes AmbiguousSession on 13-char prefix",
    () =>
      Effect.gen(function* () {
        const { a, b, asEntry } = yield* twoMachines()

        const r1Id = "756c38b6-101c-4da9-b8ba-b63399edb05a"
        const r2Id = "756c38b6-202d-4da9-b8ba-b63399edb05b"
        const bRuntime = yield* b.run(FakeRuntime)

        for (const id of [r1Id, r2Id]) {
          const pane = `p-${id.slice(9, 13)}`
          yield* bRuntime.seedAgent(pane)
          yield* b.db.session.insertSession(
            {
              ...peerSession,
              id,
              name: "remote-worker",
              createdAt: 1,
              lastActive: 1,
            },
            b.project,
            { cwd: b.directory, origin: { remote: a.id, project: a.project } },
          )
          yield* b.db.session.startProcess(id, {
            harness: "pi",
            runtime: "herdr",
            terminal: { id: pane },
          })
        }

        const local = yield* asEntry(
          a.raw["server.session"]["session.spawn"]({ payload: { agent: "general", prompt: "local", callerEnv: {} } }),
        )

        const asLocal = asSession(local.id, a.project, a.directory)

        const ambigLink = yield* Effect.flip(
          asEntry(
            a.raw["server.session"]["session.link"]({
              payload: { spec: EdgeDirected.make({ from: [{ id: local.id.slice(0, 8) }], to: [{ id: "756c38b6" }] }) },
            }),
          ),
        )

        assert.strictEqual(ambigLink._tag, "AmbiguousSession")

        if (Predicate.isTagged(ambigLink, "AmbiguousSession")) {
          assert.deepStrictEqual([...ambigLink.matches].sort(), [r1Id, r2Id].sort())
          assert.include(ambigLink.message, "retry with more characters of the session id")
        }

        const linked1 = yield* asEntry(
          a.raw["server.session"]["session.link"]({
            payload: {
              spec: EdgeDirected.make({ from: [{ id: local.id.slice(0, 8) }], to: [{ id: "756c38b6-101c" }] }),
            },
          }),
        )

        assert.deepStrictEqual(linked1.edges, [{ from: { id: local.id }, to: { id: r1Id, machine: "mb" } }])

        const targets = yield* a.db.session.linkedTargets(local.id)
        assert.deepInclude(targets, { id: r1Id, label: "on mb" })

        yield* asEntry(
          a.raw["server.session"]["session.link"]({
            payload: {
              spec: EdgeDirected.make({ from: [{ id: local.id.slice(0, 8) }], to: [{ id: "756c38b6-202d" }] }),
            },
          }),
        )

        const ambigSend = yield* Effect.flip(
          asLocal(
            a.raw["server.session"]["session.send"]({ params: { id: "756c38b6" }, payload: { message: "ambig" } }),
          ),
        )

        assert.strictEqual(ambigSend._tag, "AmbiguousSession")

        if (Predicate.isTagged(ambigSend, "AmbiguousSession")) {
          assert.deepStrictEqual([...ambigSend.matches].sort(), [r1Id, r2Id].sort())
        }

        const sent = yield* asLocal(
          a.raw["server.session"]["session.send"]({
            params: { id: "756c38b6-101c" },
            payload: { message: "resolved-13-chars" },
          }),
        )

        assert.strictEqual(sent.id, r1Id)
        yield* until(b.run(inboxOf(r1Id)), (rows) => rows.some((r) => r.content.includes("resolved-13-chars")))

        const localWithRemote = yield* asEntry(
          a.raw["server.session"]["session.spawn"]({
            payload: {
              agent: "general",
              prompt: "spawned with unqualified remote",
              with: [{ id: "756c38b6-202d" }],
              callerEnv: {},
            },
          }),
        )

        const asSpawned = asSession(localWithRemote.id, a.project, a.directory)
        yield* asSpawned(
          a.raw["server.session"]["session.send"]({
            params: { id: "756c38b6-202d" },
            payload: { message: "from spawned --with" },
          }),
        )
        yield* until(b.run(inboxOf(r2Id)), (rows) => rows.some((r) => r.content.includes("from spawned --with")))
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "local+remote 8-char prefix collisions return AmbiguousSession on Session.Link and Spawn --with (including archived local), and 13-char prefix completes",
    () =>
      Effect.gen(function* () {
        const { a, b, asEntry } = yield* twoMachines()

        const localCollidingId = "756c38b6-101c-4da9-b8ba-b63399edb05a"
        const remoteCollidingId = "756c38b6-202d-4da9-b8ba-b63399edb05b"
        const aRuntime = yield* a.run(FakeRuntime)
        const bRuntime = yield* b.run(FakeRuntime)

        yield* aRuntime.seedAgent("p-local-col")
        yield* a.db.session.insertSession(
          { ...peerSession, id: localCollidingId, name: "local-col", createdAt: 1, lastActive: 1 },
          a.project,
          { cwd: a.directory },
        )
        yield* a.db.session.startProcess(localCollidingId, {
          harness: "pi",
          runtime: "herdr",
          terminal: { id: "p-local-col" },
        })

        yield* bRuntime.seedAgent("p-remote-col")
        yield* b.db.session.insertSession(
          { ...peerSession, id: remoteCollidingId, name: "remote-col", createdAt: 1, lastActive: 1 },
          b.project,
          { cwd: b.directory, origin: { remote: a.id, project: a.project } },
        )
        yield* b.db.session.startProcess(remoteCollidingId, {
          harness: "pi",
          runtime: "herdr",
          terminal: { id: "p-remote-col" },
        })

        const peer = yield* asEntry(
          a.raw["server.session"]["session.spawn"]({ payload: { agent: "general", prompt: "peer", callerEnv: {} } }),
        )

        const ambigLiveLink = yield* Effect.flip(
          asEntry(
            a.raw["server.session"]["session.link"]({
              payload: { spec: EdgeDirected.make({ from: [{ id: peer.id.slice(0, 8) }], to: [{ id: "756c38b6" }] }) },
            }),
          ),
        )

        assert.strictEqual(ambigLiveLink._tag, "AmbiguousSession")

        if (Predicate.isTagged(ambigLiveLink, "AmbiguousSession")) {
          assert.deepStrictEqual([...ambigLiveLink.matches].sort(), [localCollidingId, remoteCollidingId].sort())
        }

        const ambigLiveSpawn = yield* Effect.flip(
          asEntry(
            a.raw["server.session"]["session.spawn"]({
              payload: {
                agent: "general",
                prompt: "colliding --with",
                with: [{ id: "756c38b6" }],
                callerEnv: {},
              },
            }),
          ),
        )

        assert.strictEqual(ambigLiveSpawn._tag, "AmbiguousSession")

        if (Predicate.isTagged(ambigLiveSpawn, "AmbiguousSession")) {
          assert.deepStrictEqual([...ambigLiveSpawn.matches].sort(), [localCollidingId, remoteCollidingId].sort())
        }

        yield* a.db.session.endProcess(localCollidingId, "archived")
        yield* a.db.session.archive(localCollidingId)

        const ambigArchivedLocalLink = yield* Effect.flip(
          asEntry(
            a.raw["server.session"]["session.link"]({
              payload: { spec: EdgeDirected.make({ from: [{ id: peer.id.slice(0, 8) }], to: [{ id: "756c38b6" }] }) },
            }),
          ),
        )

        assert.strictEqual(ambigArchivedLocalLink._tag, "AmbiguousSession")

        if (Predicate.isTagged(ambigArchivedLocalLink, "AmbiguousSession")) {
          assert.deepStrictEqual(
            [...ambigArchivedLocalLink.matches].sort(),
            [localCollidingId, remoteCollidingId].sort(),
          )
        }

        const completedRemote = yield* asEntry(
          a.raw["server.session"]["session.link"]({
            payload: {
              spec: EdgeDirected.make({ from: [{ id: peer.id.slice(0, 8) }], to: [{ id: "756c38b6-202d" }] }),
            },
          }),
        )

        assert.deepStrictEqual(completedRemote.edges, [
          { from: { id: peer.id }, to: { id: remoteCollidingId, machine: "mb" } },
        ])
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
