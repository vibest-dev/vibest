import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { unwrapped } from "@vibest/core/replies"
import { SessionLive } from "@vibest/core/session/live"
import { systemPrompt } from "@vibest/core/system-prompt"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { entryPending, projectOf } from "./fakes.ts"
import { place, session } from "./unit-helpers.ts"

const memory = <A, E>(program: Effect.Effect<A, E, Db | SqlClient.SqlClient>) =>
  program.pipe(
    Effect.provide(
      Db.layer.pipe(
        Layer.provideMerge(Platform.sqlite(":memory:")),
        Layer.provide(Bus.layer),
        Layer.provide(SessionLive.layer),
      ),
    ),
  )

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const X = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

const setup = Effect.gen(function* () {
  const db = yield* Db
  const project = yield* projectOf("r")
  const entry = yield* db.startEntry(project, "pi", false, place, { agent: "coordinator" })
  yield* db.insertSession(session(A), project, { cwd: "/w", task: "a", parentSessionId: entry.sessionId })
  return { db, project, entryId: entry.sessionId }
})

describe("sends from sessions", () => {
  it.effect("a send to the entry session waits as a pending row like a send to any session", () =>
    memory(
      Effect.gen(function* () {
        const { db, project, entryId } = yield* setup
        assert.isDefined(yield* db.insertSend(entryId, "hello", undefined, A))
        assert.deepStrictEqual(
          (yield* entryPending(db, project)).map((r) => [r.kind, r.sender, r.recipient]),
          [["send", A, entryId]],
        )
      }),
    ),
  )

  it.effect(
    "a session may send to the session that started it and to the sessions it started, and to no one else",
    () =>
      memory(
        Effect.gen(function* () {
          const { db, project, entryId } = yield* setup
          yield* db.insertSession(session(B), project, { cwd: "/w", task: "b", parentSessionId: entryId })
          yield* db.insertSession(session(X), project, { cwd: "/w", task: "x", parentSessionId: A })
          assert.isFalse(yield* db.maySend(A, B))
          assert.isFalse(yield* db.maySend(B, A))
          assert.isFalse(yield* db.maySend(X, entryId))
          assert.isTrue(yield* db.maySend(entryId, B))
          assert.isTrue(yield* db.maySend(B, entryId))
          assert.isTrue(yield* db.maySend(A, X))
          assert.isTrue(yield* db.maySend(X, A))
        }),
      ),
  )

  it.effect(
    "a session whose creator has ended still names it as its creator, and its notices go to the nearest creator above that is running",
    () =>
      memory(
        Effect.gen(function* () {
          const { db, project, entryId } = yield* setup
          yield* db.insertSession(session(B), project, { cwd: "/w", task: "b", parentSessionId: A })
          yield* db.updateSession(A, { metadata: { archived: true, removed: true } })
          assert.deepStrictEqual(yield* db.nearestAlive(B), { local: entryId })
          assert.isTrue(yield* db.maySend(B, A))
          const creator = yield* db.creatorLabel(B)
          assert.deepStrictEqual(creator, { id: A, label: `agent ${session(A).name}` })
          const prompt = systemPrompt({
            system: "",
            id: B,
            projectDir: "/w",
            vibest: ["vibest"],
            preferences: "",
            memories: "",
            creator,
          })
          assert.include(prompt, `send ${A} --`)
          assert.include(prompt, "nearest session above it that is still running")
        }),
      ),
  )

  it.effect("a send dropped because the entry session is gone ends with one notice to its sender", () =>
    memory(
      Effect.gen(function* () {
        const { db, entryId } = yield* setup
        const sent = (yield* db.insertSend(entryId, "hello", undefined, A))!
        yield* db.clearEntry(place.runtime, place.address)
        assert.strictEqual((yield* db.inboxWithStatus(A, "pending")).filter((r) => r.kind === "notice").length, 1)
        const [note] = yield* db.pendingInbox(A)
        assert.include(note!.message, "was not delivered")
        assert.include(note!.message, "hello")
        assert.strictEqual(note!.recipient, A)
        assert.strictEqual((yield* db.setInboxStatus(entryId, [sent.id], "dropped")).length, 0)
      }),
    ),
  )

  it.effect("a send in flight when vibestd stopped ends failed with one notice to its sender", () =>
    memory(
      Effect.gen(function* () {
        const { db, entryId } = yield* setup
        const sent = (yield* db.insertSend(entryId, "hello", undefined, A))!
        yield* db.claim(entryId, [sent.id])
        yield* db.recoverDelivering((_, messages) => messages.join("\n"))
        assert.strictEqual((yield* db.inboxWithStatus(A, "pending")).length, 1)
        assert.include((yield* db.pendingInbox(A))[0]!.message, "hello")
      }),
    ),
  )

  it.effect("when the sender is gone the notice goes to the sender's creator, not the recipient's", () =>
    memory(
      Effect.gen(function* () {
        const { db, project, entryId } = yield* setup
        yield* db.insertSession(session(X), project, { cwd: "/w", task: "x", parentSessionId: entryId })
        yield* db.insertSession(session(B), project, { cwd: "/w", task: "b", parentSessionId: A })
        const sent = (yield* db.insertSend(B, "hello", undefined, A))!
        yield* db.updateSession(A, { metadata: { archived: true, removed: true } })
        yield* db.claim(B, [sent.id])
        yield* db.recoverDelivering(() => "cut")
        assert.deepStrictEqual(yield* db.pendingInbox(X), [])
        assert.deepStrictEqual(
          (yield* entryPending(db, project)).map((r) => [r.kind, r.sender, unwrapped(r.message)]),
          [["notice", A, "cut"]],
        )
      }),
    ),
  )

  it.effect("a send to the creator on another machine goes to the outbox as a notice", () =>
    memory(
      Effect.gen(function* () {
        const { db, project } = yield* setup
        const sql = yield* SqlClient.SqlClient
        yield* db.notePeer({ id: "11111111-1111-4111-8111-111111111111", name: "other" })
        yield* db.insertSession(session(B), project, {
          cwd: "/w",
          task: "b",
          origin: {
            peer: "11111111-1111-4111-8111-111111111111",
            project: "p",
            reportTo: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          },
        })
        assert.isUndefined(yield* db.sendToOrigin(B, "eeeeeeee", "hi"))
        assert.isTrue(yield* db.sendToOrigin(B, "dddddddd", "hi"))
        const out = yield* sql<{ kind: string; content: string }>`SELECT kind, content FROM outbox`
        assert.deepStrictEqual(out, [{ kind: "send", content: "hi" }])
      }),
    ),
  )

  it.effect("a send to a creator on a machine vibestd does not know writes nothing and says so", () =>
    memory(
      Effect.gen(function* () {
        const { db, project } = yield* setup
        const sql = yield* SqlClient.SqlClient
        yield* db.insertSession(session(B), project, {
          cwd: "/w",
          task: "b",
          origin: { peer: "22222222-2222-4222-8222-222222222222", project: "p", reportTo: X },
        })
        assert.isFalse(yield* db.sendToOrigin(B, "cccccccc", "hi"))
        assert.deepStrictEqual(yield* sql`SELECT 1 FROM outbox`, [])
      }),
    ),
  )

  it.effect("a send from the user that was cut writes no notice: the user has no inbox", () =>
    memory(
      Effect.gen(function* () {
        const { db, project, entryId } = yield* setup
        const first = (yield* db.insertSend(entryId, "one"))!
        yield* db.claim(entryId, [first.id])
        yield* db.recoverDelivering(() => "cut")
        assert.deepStrictEqual(yield* entryPending(db, project), [])
      }),
    ),
  )
})
