import { assert, describe, it } from "@effect/vitest"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { EdgeDirected, EdgeMutual } from "@vibest/protocol/rpc"
import { Effect, Predicate, Stream } from "effect"
import { RpcClient } from "effect/rpc"

import * as Platform from "#platform"

import { until } from "./lib/fakes.ts"
import { inboxOf, onB, outboxRows, repoStack, twoMachines } from "./lib/machines-fakes.ts"

const asSession =
  (sessionId: string, projectId: string, repositoryRoot: string) =>
  <A, E>(effect: Effect.Effect<A, E>) =>
    RpcClient.withHeaders(effect, sessionHeaders({ sessionId, projectId, repositoryRoot }))

describe("cross-machine directed session graph", () => {
  it.effect("Session.Link/Unlink across local<->remote enforces directed sends and updates WatchSession.to", () =>
    Effect.gen(function* () {
      const { a, b, entryId, asEntry } = yield* twoMachines()

      const local = yield* asEntry(a.raw.Spawn({ agent: "general", prompt: "local worker", callerEnv: {} }))

      const remote = yield* asEntry(
        a.raw.Spawn({ agent: "general", machine: "mb", prompt: "remote worker", callerEnv: {} }),
      )

      const remoteId = onB(remote.id)
      const asLocal = asSession(local.id, a.project, a.directory)
      const asRemote = asSession(remoteId, b.project, b.directory)

      const blockedForward = yield* Effect.flip(asLocal(a.raw.Send({ id: remote.id, message: "blocked" })))
      assert.strictEqual(blockedForward._tag, "Forbidden")

      const blockedBack = yield* Effect.flip(asRemote(b.raw.Send({ id: local.id, message: "blocked back" })))
      assert.strictEqual(blockedBack._tag, "NoSuchSession")

      yield* asEntry(a.raw["Session.Link"]({ spec: EdgeDirected.make({ from: [local.id], to: [remote.id] }) }))

      yield* asLocal(a.raw.Send({ id: remote.id, message: "local to remote" }))

      const bInbox = yield* until(b.run(inboxOf(remoteId)), (rows) =>
        rows.some((r) => r.content.includes("local to remote")),
      )

      assert.isTrue(bInbox.some((r) => r.content.includes("local to remote")))

      const stillBlockedBack = yield* Effect.flip(asRemote(b.raw.Send({ id: local.id, message: "still blocked" })))
      assert.strictEqual(stillBlockedBack._tag, "NoSuchSession")

      yield* asEntry(a.raw["Session.Link"]({ spec: EdgeDirected.make({ from: [remote.id], to: [local.id] }) }))
      yield* asRemote(b.raw.Send({ id: local.id.slice(0, 8), message: "remote to local" }))

      const aInbox = yield* until(a.run(inboxOf(local.id)), (rows) =>
        rows.some((r) => r.content.includes("remote to local")),
      )

      assert.isTrue(aInbox.some((r) => r.content.includes("remote to local")))

      const [snap] = yield* until(a.cli(a.raw.Watch(undefined).pipe(Stream.take(1), Stream.runCollect)), (chunk) => {
        const first = chunk[0]

        if (first === undefined || !Predicate.isTagged(first, "Snapshot")) return false
        const localRow = first.sessions.find((s) => s.id === local.id && s.machine === undefined)
        const remoteRow = first.sessions.find((s) => s.id === remoteId && s.machine === "mb")

        return (
          localRow !== undefined &&
          remoteRow !== undefined &&
          localRow.to.includes(remoteId) &&
          remoteRow.to.includes(local.id) &&
          remoteRow.to.includes(entryId)
        )
      })

      assert.isDefined(snap)

      yield* asEntry(a.raw["Session.Unlink"]({ spec: EdgeMutual.make({ ids: [local.id, remote.id] }) }))

      const afterUnlink = yield* Effect.flip(asLocal(a.raw.Send({ id: remote.id, message: "after unlink" })))
      assert.strictEqual(afterUnlink._tag, "Forbidden")
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("vibest run --machine with --with links the remote session with local siblings immediately", () =>
    Effect.gen(function* () {
      const { a, b, asEntry } = yield* twoMachines()

      const local = yield* asEntry(a.raw.Spawn({ agent: "general", prompt: "local sibling", callerEnv: {} }))

      const remote = yield* asEntry(
        a.raw.Spawn({
          agent: "general",
          machine: "mb",
          prompt: "remote sibling",
          with: [local.id],
          callerEnv: {},
        }),
      )

      const remoteId = onB(remote.id)
      const asLocal = asSession(local.id, a.project, a.directory)
      const asRemote = asSession(remoteId, b.project, b.directory)

      yield* asLocal(a.raw.Send({ id: remote.id, message: "ping via --with" }))
      yield* until(b.run(inboxOf(remoteId)), (rows) => rows.some((r) => r.content.includes("ping via --with")))

      yield* asRemote(b.raw.Send({ id: local.id, message: "pong via --with" }))
      yield* until(a.run(inboxOf(local.id)), (rows) => rows.some((r) => r.content.includes("pong via --with")))
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("remote A -> remote B linked send relays through the initiator machine", () =>
    Effect.gen(function* () {
      const { net, a, b, asEntry } = yield* twoMachines()
      const c = yield* repoStack(net)
      net.route("c-host", c.layout.socket)
      yield* a.cli(a.raw["Machine.Add"]({ name: "mc", target: "c-host" }))
      yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows.every((r) => r.state === "connected"))

      const onMb = yield* asEntry(a.raw.Spawn({ agent: "general", machine: "mb", prompt: "on b", callerEnv: {} }))
      const onMc = yield* asEntry(a.raw.Spawn({ agent: "general", machine: "mc", prompt: "on c", callerEnv: {} }))
      const rbId = onB(onMb.id)
      const rcId = onB(onMc.id)

      yield* asEntry(a.raw["Session.Link"]({ spec: EdgeDirected.make({ from: [onMb.id], to: [onMc.id] }) }))

      const asRb = asSession(rbId, b.project, b.directory)
      yield* asRb(b.raw.Send({ id: rcId, message: "relay from mb to mc" }))

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

        const s1 = yield* asEntry(a.raw.Spawn({ agent: "general", prompt: "s1", callerEnv: {} }))
        const s2 = yield* asEntry(a.raw.Spawn({ agent: "general", prompt: "s2", callerEnv: {} }))

        const mutualDup = yield* asEntry(
          a.raw["Session.Link"]({ spec: EdgeMutual.make({ ids: [s1.id, s2.id, s1.id] }) }),
        )

        assert.deepStrictEqual(mutualDup.edges, [
          { from: s1.id, to: s2.id },
          { from: s2.id, to: s1.id },
        ])

        const mutualSelf = yield* Effect.flip(
          asEntry(a.raw["Session.Link"]({ spec: EdgeMutual.make({ ids: [s1.id, s1.id] }) })),
        )

        assert.strictEqual(mutualSelf._tag, "Forbidden")
        assert.include(mutualSelf.message, "at least two distinct sessions")

        const directedOverlap = yield* asEntry(
          a.raw["Session.Link"]({ spec: EdgeDirected.make({ from: [s1.id, s2.id], to: [s1.id, s2.id] }) }),
        )

        assert.deepStrictEqual(directedOverlap.edges, [
          { from: s1.id, to: s2.id },
          { from: s2.id, to: s1.id },
        ])

        const invalidSpawn = yield* Effect.flip(
          asEntry(
            a.raw.Spawn({
              agent: "general",
              machine: "mb",
              prompt: "should not start",
              with: ["00000000-0000-4000-8000-000000000000"],
              callerEnv: {},
            }),
          ),
        )

        assert.strictEqual(invalidSpawn._tag, "NoSuchSession")
        assert.lengthOf(b.spawns, 0)

        const remote = yield* asEntry(a.raw.Spawn({ agent: "general", machine: "mb", prompt: "r1", callerEnv: {} }))
        const remoteId = onB(remote.id)
        yield* asEntry(a.raw["Session.Link"]({ spec: EdgeDirected.make({ from: [s1.id], to: [remote.id] }) }))

        const asS1 = asSession(s1.id, a.project, a.directory)

        const shortSend = yield* Effect.flip(asS1(a.raw.Send({ id: `mb/${remoteId.slice(0, 4)}`, message: "short" })))
        assert.strictEqual(shortSend._tag, "Forbidden")

        const shortLink = yield* Effect.flip(
          asEntry(
            a.raw["Session.Link"]({ spec: EdgeDirected.make({ from: [s1.id], to: [`mb/${remoteId.slice(0, 4)}`] }) }),
          ),
        )

        assert.strictEqual(shortLink._tag, "NoSuchSession")

        yield* b.db.session.endProcess(remoteId, "archived")
        yield* b.db.session.archive(remoteId)

        const archivedLink = yield* Effect.flip(
          asEntry(a.raw["Session.Link"]({ spec: EdgeDirected.make({ from: [s1.id], to: [remote.id] }) })),
        )

        assert.strictEqual(archivedLink._tag, "NoSuchSession")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("initiator relay leaves outbox item unacked when target machine is unreachable", () =>
    Effect.gen(function* () {
      const { net, a, b, asEntry } = yield* twoMachines()
      const c = yield* repoStack(net)
      net.route("c-host", c.layout.socket)
      yield* a.cli(a.raw["Machine.Add"]({ name: "mc", target: "c-host" }))
      yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows.every((r) => r.state === "connected"))

      const onMb = yield* asEntry(a.raw.Spawn({ agent: "general", machine: "mb", prompt: "on b", callerEnv: {} }))
      const onMc = yield* asEntry(a.raw.Spawn({ agent: "general", machine: "mc", prompt: "on c", callerEnv: {} }))
      const rbId = onB(onMb.id)
      const rcId = onB(onMc.id)

      yield* asEntry(a.raw["Session.Link"]({ spec: EdgeDirected.make({ from: [onMb.id], to: [onMc.id] }) }))

      net.fail("c-host", 255, "connection refused")
      yield* net.cutAll("c-host")
      yield* until(a.cli(a.raw["Machine.List"]()), (rows) => rows.find((r) => r.name === "mc")?.state === "unreachable")

      const asRb = asSession(rbId, b.project, b.directory)
      yield* asRb(b.raw.Send({ id: rcId, message: "queued while mc down" }))

      const pending = yield* until(b.run(outboxRows), (rows) => rows.length === 1)
      assert.lengthOf(pending, 1)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
