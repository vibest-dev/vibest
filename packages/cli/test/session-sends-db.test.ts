import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
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

  it.effect(
    "a send to the nearest living creator on another machine reaches that machine's outbox from any depth",
    () =>
      memory(
        Effect.gen(function* () {
          const { db, project } = yield* setup
          const peer = "11111111-1111-4111-8111-111111111111"
          const reportTo = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
          yield* db.notePeer({ id: peer, name: "other" })
          yield* db.insertSession(session(B), project, {
            cwd: "/w",
            task: "b",
            origin: { peer, project: "p", reportTo },
          })
          yield* db.insertSession(session(X), project, { cwd: "/w", task: "x", parentSessionId: B })
          yield* db.updateSession(B, { metadata: { archived: true, removed: true } })
          const heir = yield* db.nearestAlive(X)
          assert.deepStrictEqual(heir, { peer, session: reportTo })
          assert.isTrue(yield* db.sendToPeer(X, peer, reportTo, "report"))
          const out = yield* db.outboxOf(peer)
          assert.deepInclude(out[0]!, { kind: "send", content: "report", reportTo })
          assert.isFalse(yield* db.sendToPeer(X, "22222222-2222-4222-8222-222222222222", reportTo, "report"))
        }),
      ),
  )

  it.effect(
    "an item for an ended session whose nearest living creator is on another machine goes on to that machine, once",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const { db, project } = yield* setup
        const peer = "11111111-1111-4111-8111-111111111111"
        const reportTo = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        const middle = B
        const ended = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        yield* db.notePeer({ id: peer, name: "other" })
        yield* db.insertSession(session(middle), project, { origin: { peer, project: "p", reportTo } })
        yield* db.insertSession(session(ended), project, { parentSessionId: middle })
        yield* db.updateSession(middle, { metadata: { archived: true, removed: true } })
        yield* db.updateSession(ended, { metadata: { archived: true, removed: true } })
        const item = {
          id: "7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f",
          recipient: ended,
          kind: "send" as const,
          sender: "mb/cccccccc",
          content: "report",
        }
        assert.strictEqual(yield* db.receivePeerItem(item), "queued")
        assert.strictEqual(yield* db.receivePeerItem(item), "duplicate")
        assert.deepStrictEqual(yield* sql`SELECT status FROM inbox WHERE session_id = ${ended}`, [
          { status: "dropped" },
        ])
        const out = yield* db.outboxOf(peer)
        assert.lengthOf(out, 1)
        assert.deepInclude(out[0]!, { kind: "send", content: "mb/cccccccc: report", reportTo })
      }).pipe(memory),
  )
})
