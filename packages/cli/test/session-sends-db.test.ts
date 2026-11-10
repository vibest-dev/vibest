import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { projectOf } from "./fakes.ts"
import { place, session } from "./unit-helpers.ts"

const memory = <A, E>(program: Effect.Effect<A, E, Db | SqlClient.SqlClient>) =>
  program.pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:")), Layer.provide(Bus.layer))))

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const X = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

const setup = Effect.gen(function* () {
  const db = yield* Db
  const project = yield* projectOf("r")
  const main = yield* db.coordinatorLaunch(project, "pi", false, place)
  yield* db.insertSession(session(A), project, { cwd: "/w", task: "a", parentSessionId: main.sessionId })
  return { db, project, main: main.sessionId }
})

describe("sends from sessions", () => {
  it.effect("a send to the main agent is for its poll or subscribe path, never for typing", () =>
    memory(
      Effect.gen(function* () {
        const { db, project, main } = yield* setup
        assert.isDefined(yield* db.insertSend(main, "hello", undefined, A))
        assert.deepStrictEqual(yield* db.pendingInbox(main), [])
        assert.deepStrictEqual(
          (yield* db.coordinatorPending(project)).map((r) => [r.kind, r.sender, r.recipient]),
          [["send", A, main]],
        )
      }),
    ),
  )

  it.effect("a send dropped because the main agent is gone ends with one notice to its sender", () =>
    memory(
      Effect.gen(function* () {
        const { db, project, main } = yield* setup
        const sent = (yield* db.insertSend(main, "hello", undefined, A))!
        yield* db.dropWaiting(project)
        assert.strictEqual((yield* db.inboxWithStatus(A, "pending")).filter((r) => r.kind === "notice").length, 1)
        const [note] = yield* db.pendingInbox(A)
        assert.include(note!.message, "was not delivered")
        assert.include(note!.message, "hello")
        assert.strictEqual(note!.recipient, A)
        assert.strictEqual((yield* db.setInboxStatus([sent.id], "dropped")).length, 0)
      }),
    ),
  )

  it.effect("a send in flight to a main agent that does not poll ends failed with one notice to its sender", () =>
    memory(
      Effect.gen(function* () {
        const { db, main } = yield* setup
        const sent = (yield* db.insertSend(main, "hello", undefined, A))!
        yield* db.claim([sent.id])
        yield* db.recoverDelivering([], () => "")
        assert.strictEqual((yield* db.inboxWithStatus(A, "pending")).length, 1)
        assert.include((yield* db.pendingInbox(A))[0]!.message, "hello")
      }),
    ),
  )

  it.effect("a send failed with its subscription lease ends with one notice to its sender", () =>
    memory(
      Effect.gen(function* () {
        const { db, main } = yield* setup
        const sent = (yield* db.insertSend(main, "hello", undefined, A))!
        yield* db.claim([sent.id])
        yield* db.failLeased([sent.id])
        assert.strictEqual((yield* db.pendingInbox(A)).length, 1)
      }),
    ),
  )

  it.effect("when the sender is gone the notice goes to the sender's creator, not the recipient's", () =>
    memory(
      Effect.gen(function* () {
        const { db, project, main } = yield* setup
        yield* db.insertSession(session(X), project, { cwd: "/w", task: "x", parentSessionId: main })
        yield* db.insertSession(session(B), project, { cwd: "/w", task: "b", parentSessionId: X })
        const sent = (yield* db.insertSend(B, "hello", undefined, A))!
        yield* db.updateSession(A, { metadata: { archived: true, removed: true } })
        yield* db.claim([sent.id])
        yield* db.recoverDelivering([], () => "cut")
        assert.deepStrictEqual(yield* db.pendingInbox(X), [])
        assert.deepStrictEqual(
          (yield* db.coordinatorPending(project)).map((r) => [r.kind, r.sender, r.message]),
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
        yield* db.notePeer({ id: "11111111-1111-4111-8111-111111111111", name: "other", callsMe: "x" })
        yield* db.insertSession(session(B), project, {
          cwd: "/w",
          task: "b",
          origin: {
            peer: "11111111-1111-4111-8111-111111111111",
            project: "p",
            reportTo: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          },
        })
        assert.isFalse(yield* db.sendToOrigin(B, "eeeeeeee", "hi"))
        assert.isTrue(yield* db.sendToOrigin(B, "dddddddd", "hi"))
        const out = yield* sql<{ kind: string; content: string }>`SELECT kind, content FROM outbox`
        assert.deepStrictEqual(
          out.map((o) => o.kind),
          ["notice"],
        )
        assert.include(out[0]!.content, "<agent-message>")
        assert.include(out[0]!.content, "hi")
      }),
    ),
  )
})
