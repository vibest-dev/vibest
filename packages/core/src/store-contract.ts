// The storage port's contract (db.ts `DbShape`, docs/architecture.md, storage), as tests every implementation must
// pass: the in-memory store (memory-store.test.ts) and vibest's SQLite store (apps/vibest/test/store-contract.test.ts).
// Each case gets a fresh, empty store from `layer`.
import { assert, describe, it } from "@effect/vitest"
import { Effect, type Layer } from "effect"

import { Db, encodeAddress, type SessionRow } from "./db.ts"

const RUNTIME = "fake"

export const sessionRow = (id: string, patch: Partial<Omit<SessionRow, "scope">> = {}): Omit<SessionRow, "scope"> => ({
  id,
  agent: "general",
  name: "n",
  harnessId: "pi",
  provider: null,
  model: null,
  harnessSessionId: null,
  runtime: RUNTIME,
  address: { machine: "local", id: `t-${id}` },
  status: "unknown",
  startedAt: 1,
  exitedAt: null,
  turnState: "none",
  turnPromptedAt: 0,
  metadata: {},
  createdAt: 1,
  lastActive: 1,
  ...patch,
})

const place = (id: string) => ({ runtime: RUNTIME, address: { machine: "local", id } })

export const storeContract = (name: string, layer: Layer.Layer<Db, unknown>) =>
  describe(`storage port contract: ${name}`, () => {
    const test = (title: string, body: Effect.Effect<void, unknown, Db>) =>
      it.effect(title, () => body.pipe(Effect.provide(layer)))

    test(
      "sessions: inserted in a scope, read back, listed per scope; `max` refuses all or nothing; unknown ids are absent",
      Effect.gen(function* () {
        const db = yield* Db
        assert.isTrue(yield* db.insertSession(sessionRow("a1"), "s1", undefined, "/w/a", "do a"))
        assert.isTrue(yield* db.insertSession(sessionRow("b1"), "s2"))
        assert.isFalse(yield* db.insertSession(sessionRow("c1"), "s1", 2))
        assert.isFalse(yield* db.sessionExists("c1"))
        assert.strictEqual((yield* db.getSession("a1"))?.scope, "s1")
        assert.strictEqual(yield* db.scopeOf("b1"), "s2")
        assert.strictEqual(yield* db.sessionDirectory("a1"), "/w/a")
        assert.deepStrictEqual(
          (yield* db.listSessions({ scope: "s1" })).map((s) => s.id),
          ["a1"],
        )
        assert.deepStrictEqual(
          (yield* db.listSessions()).map((s) => s.id),
          ["a1", "b1"],
        )
        assert.deepStrictEqual(yield* db.sessionIdentity("a1"), {
          id: "a1",
          scope: "s1",
          agent: "general",
          harness: "pi",
          owner: false,
        })
        assert.strictEqual(yield* db.getSession("nope"), undefined)
        assert.strictEqual(yield* db.sessionIdentity("nope"), undefined)
        assert.strictEqual((yield* db.sessionBriefs(["a1", "nope"])).get("a1")?.task, "do a")
        assert.isFalse((yield* db.sessionBriefs(["a1", "nope"])).has("nope"))
      }),
    )

    test(
      "provenance and shared directories: descends follows parents upward; sharers are live sessions of one directory",
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.insertSession(sessionRow("p1", { createdAt: 1 }), "s", undefined, "/w/1")
        yield* db.insertSession(sessionRow("c1", { createdAt: 2 }), "s", undefined, "/w/1", undefined, "p1")
        yield* db.insertSession(sessionRow("g1", { createdAt: 3 }), "s", undefined, "/w/2", undefined, "c1")
        assert.isTrue(yield* db.descends("g1", "p1"))
        assert.isFalse(yield* db.descends("p1", "g1"))
        assert.strictEqual(yield* db.parentOf("c1"), "p1")
        assert.deepStrictEqual(yield* db.liveSharers("p1"), ["c1"])
        assert.strictEqual(yield* db.earlierSharer("c1"), "p1")
        assert.strictEqual(yield* db.earlierSharer("p1"), undefined)
        const c1 = (yield* db.getSession("c1"))!
        yield* db.updateSession("c1", { metadata: { ...c1.metadata, archived: true, removed: true } })
        assert.deepStrictEqual(yield* db.liveSharers("p1"), [])
      }),
    )

    test(
      "processes: one end per process; a restart keeps the open turn and its conversation; ended ones leave the live list",
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.insertSession(sessionRow("a1", { harnessSessionId: "conv-1" }), "s")
        yield* db.updateSession("a1", { turnState: "open", turnPromptedAt: 5 })
        assert.strictEqual(yield* db.readyAt("a1"), undefined)
        yield* db.patchLive("a1", { ready: 7, pid: 42 })
        assert.strictEqual(yield* db.readyAt("a1"), 7)
        assert.strictEqual((yield* db.getSession("a1"))?.metadata.pid, 42)
        yield* db.restartProcess("a1")
        const after = (yield* db.getSession("a1"))!
        assert.strictEqual(after.turnState, "open")
        assert.strictEqual(after.harnessSessionId, "conv-1")
        assert.strictEqual(yield* db.readyAt("a1"), undefined)
        assert.isTrue(yield* db.endProcess("a1", "exited"))
        assert.isFalse(yield* db.endProcess("a1", "exited"))
        assert.deepStrictEqual(yield* db.listSessions(), [])
        assert.deepStrictEqual(
          (yield* db.listSessions({ stopped: true })).map((s) => s.id),
          ["a1"],
        )
        assert.isTrue(yield* db.noteHarnessSession("a1", "conv-2"))
        assert.isFalse(yield* db.noteHarnessSession("a1", "conv-2"))
      }),
    )

    test(
      "turns: a typed turn is taken; one end per turn; a result goes to the senders the turn consumed",
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.insertSession(sessionRow("a1"), "s")
        yield* db.insertSession(sessionRow("b1"), "s")
        assert.isTrue(yield* db.beginUserTurn("a1", "hello", {}))
        assert.isFalse(yield* db.beginUserTurn("a1", "again", {}))
        assert.isTrue(yield* db.turnTaken("a1"))
        yield* db.closeTurn("a1", "completed", {})
        assert.isFalse(yield* db.turnTaken("a1"))
        assert.strictEqual((yield* db.getSession("a1"))?.turnState, "completed")
        // A sends to B; B's turn takes it; B's result goes back to A.
        const sent = (yield* db.insertSend("b1", "question", "a1"))!
        assert.strictEqual(sent.status, "pending")
        assert.deepStrictEqual(
          (yield* db.pendingInbox("b1")).map((r) => r.id),
          [sent.id],
        )
        yield* db.updateSession("b1", { turnState: "open", turnPromptedAt: 10 })
        yield* db.setInboxStatus([sent.id], "delivered", "pending")
        assert.isTrue(yield* db.turnTaken("b1"))
        assert.deepStrictEqual(yield* db.replyTo("b1"), ["a1"])
        const [result] = yield* db.finishTurn(
          "b1",
          { status: "completed", output: "answer" },
          { turnState: "completed" },
          { sessionId: "b1", kind: "result", message: "<summary>answer</summary>", details: {} },
        )
        assert.strictEqual(result?.kind, "result")
        assert.strictEqual(result?.details.status, "completed")
        assert.deepStrictEqual(
          (yield* db.pendingInbox("a1")).map((r) => r.id),
          [result!.id],
        )
        assert.strictEqual((yield* db.getSession("b1"))?.turnState, "completed")
        assert.strictEqual((yield* db.sessionBriefs(["b1"])).get("b1")?.latest?.summary, "answer")
        assert.strictEqual((yield* db.latestInbox("b1", "result"))?.id, result!.id)
        assert.isDefined(yield* db.latestRoundAt("b1"))
      }),
    )

    test(
      "inbox: a claim is exclusive, even when many race for the same rows; a guarded move needs the status it names",
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.insertSession(sessionRow("a1"), "s")
        const rows = yield* Effect.forEach(["one", "two", "three"], (m) => db.insertSend("a1", m))
        const ids = rows.map((r) => r!.id)
        const claims = yield* Effect.all(
          Array.from({ length: 8 }, () => db.claim(ids)),
          { concurrency: "unbounded" },
        )
        assert.deepStrictEqual(claims.flat().toSorted(), [...ids].toSorted())
        assert.deepStrictEqual(
          (yield* db.inboxWithStatus("a1", "sending")).map((r) => r.id),
          ids,
        )
        assert.deepStrictEqual(yield* db.ownInbox("a1", ids), ids)
        assert.lengthOf(yield* db.setInboxStatus(ids, "delivered", "pending"), 0)
        assert.lengthOf(yield* db.setInboxStatus(ids, "delivered", "sending"), 3)
        assert.deepStrictEqual(yield* db.ownInbox("a1", ids), [])
        // A pending send keeps the session from being archived; then the archive refuses new sends.
        yield* db.insertSend("a1", "four")
        assert.isFalse(yield* db.archiveIfNoPending("a1"))
        yield* db.setInboxStatus(
          (yield* db.inboxWithStatus("a1", "pending")).map((r) => r.id),
          "dropped",
        )
        assert.isTrue(yield* db.archiveIfNoPending("a1"))
        assert.strictEqual(yield* db.insertSend("a1", "five"), undefined)
      }),
    )

    test(
      "the user: a notice with no owner is the user's; userInbox reads a scope's, and marks them read",
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.insertSession(sessionRow("a1"), "s")
        yield* db.insertSession(sessionRow("b1"), "other")
        assert.deepStrictEqual(yield* db.noticeTo("a1"), [null])
        yield* db.insertInbox({ sessionId: "a1", kind: "notice", message: "hi", details: {} })
        yield* db.insertInbox({ sessionId: "b1", kind: "notice", message: "elsewhere", details: {} })
        assert.deepStrictEqual(
          (yield* db.userInbox("s", false)).map((r) => r.message),
          ["hi"],
        )
        assert.lengthOf(yield* db.userInbox("s", true), 1)
        assert.deepStrictEqual(yield* db.userInbox("s", false), [])
        // No recipient at all: kept as the sender's own, dropped.
        const [own] = yield* db.insertInbox({ sessionId: "a1", kind: "report", message: "x", details: {} }, [])
        assert.strictEqual(own?.status, "dropped")
      }),
    )

    test(
      "owners: a scope's owner gets its rows while it has a place, claims are guarded by that place, leases settle",
      Effect.gen(function* () {
        const db = yield* Db
        const started = yield* db.startOwner("s", "pi", false, place("o1"), { directory: "/repo" })
        yield* db.insertSession(sessionRow("a1"), "s")
        const owner = (yield* db.ownerOf("s"))!
        assert.strictEqual(owner.id, started.sessionId)
        assert.strictEqual(owner.directory, "/repo")
        assert.strictEqual(yield* db.ownerAt(RUNTIME, place("o1").address), "s")
        assert.deepStrictEqual(
          (yield* db.owners).map((o) => o.scope),
          ["s"],
        )
        assert.isTrue((yield* db.sessionIdentity(started.sessionId))?.owner)
        assert.deepStrictEqual(
          (yield* db.listSessions()).map((s) => s.id),
          ["a1"],
        )
        assert.deepStrictEqual(yield* db.noticeTo("a1"), [started.sessionId])
        const [notice] = yield* db.insertInbox({ sessionId: "a1", kind: "notice", message: "n1", details: {} })
        assert.deepStrictEqual(
          (yield* db.ownerPending("s")).map((r) => r.id),
          [notice!.id],
        )
        assert.deepStrictEqual(yield* db.pendingScopes, ["s"])
        // The owner's own rows are the owner's inbox, not what it takes as a session.
        assert.deepStrictEqual(yield* db.pendingInbox(started.sessionId), [])
        const address = encodeAddress(place("o1").address)
        assert.deepStrictEqual(
          yield* db.claim([notice!.id], { scope: "s", runtime: RUNTIME, address: "elsewhere" }),
          [],
        )
        assert.deepStrictEqual(yield* db.claim([notice!.id], { scope: "s", runtime: RUNTIME, address }), [notice!.id])
        assert.deepStrictEqual(yield* db.releaseLeased("s", [notice!.id]), [notice!.id])
        yield* db.claim([notice!.id], { scope: "s", runtime: RUNTIME, address })
        assert.deepStrictEqual(
          (yield* db.settleLeased("s", [notice!.id], [])).map((r) => r.id),
          [notice!.id],
        )
        assert.deepStrictEqual(yield* db.settleLeased("other", [notice!.id], []), [])
        // Its place gone: the owner-bound rows waiting for it drop, and a new one to it is dropped at once.
        yield* db.insertInbox({ sessionId: "a1", kind: "notice", message: "n2", details: {} })
        yield* db.clearOwnerAt(RUNTIME, place("o1").address)
        assert.strictEqual((yield* db.ownerOf("s"))?.runtime, null)
        assert.deepStrictEqual(yield* db.ownerPending("s"), [])
        const [late] = yield* db.insertInbox({ sessionId: "a1", kind: "notice", message: "n3", details: {} })
        assert.strictEqual(late?.status, "dropped")
      }),
    )

    test(
      "owners: the same harness continues its conversation; a fresh start replaces the owner, which stays readable",
      Effect.gen(function* () {
        const db = yield* Db
        const first = yield* db.startOwner("s", "pi", false, place("o1"))
        yield* db.reportOwnerConversation(first.sessionId, "pi", "conv-1")
        yield* db.reportOwnerConversation(first.sessionId, "claude", "ignored")
        const again = yield* db.startOwner("s", "pi", false, place("o2"))
        assert.deepStrictEqual(again, { sessionId: first.sessionId, harnessSessionId: "conv-1" })
        assert.strictEqual(yield* db.ownerAt(RUNTIME, place("o1").address), undefined)
        // Another scope's owner starting at the same place takes it.
        yield* db.startOwner("t", "pi", false, place("o2"))
        assert.strictEqual((yield* db.ownerOf("s"))?.runtime, null)
        const fresh = yield* db.startOwner("s", "pi", true, place("o3"))
        assert.notStrictEqual(fresh.sessionId, first.sessionId)
        assert.strictEqual(fresh.harnessSessionId, null)
        assert.strictEqual((yield* db.getSession(first.sessionId))?.id, first.sessionId)
        assert.strictEqual((yield* db.ownerOf("s"))?.id, fresh.sessionId)
        // Moving: no place while it moves, and its rows wait for the next start there.
        assert.isTrue(yield* db.detachOwner("s", RUNTIME, place("o3").address))
        assert.strictEqual((yield* db.ownerOf("s"))?.runtime, null)
        yield* db.reattachOwner("s", RUNTIME, place("o3").address)
        assert.strictEqual((yield* db.ownerOf("s"))?.runtime, RUNTIME)
      }),
    )

    test(
      "after a restart: an owner's cut-off claims go back to pending when it polls, else fail; a session's stay",
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.startOwner("s", "pi", false, place("o1"))
        yield* db.insertSession(sessionRow("a1"), "s")
        const [n] = yield* db.insertInbox({ sessionId: "a1", kind: "notice", message: "n", details: {} })
        const sent = (yield* db.insertSend("a1", "m"))!
        yield* db.claim([n!.id, sent.id])
        assert.lengthOf(yield* db.sendingInbox, 2)
        yield* db.recoverSending(["pi"])
        assert.deepStrictEqual(
          (yield* db.ownerPending("s")).map((r) => r.id),
          [n!.id],
        )
        yield* db.claim([n!.id])
        yield* db.recoverSending([])
        assert.deepStrictEqual(
          (yield* db.sendingInbox).map((r) => r.id),
          [sent.id],
        )
        assert.strictEqual((yield* db.latestInbox("a1", "notice"))?.status, "failed")
      }),
    )
  })
