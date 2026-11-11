import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { sessionSystemPrompt } from "@vibest/core/system-prompt"
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

  it.effect("a send to a sibling writes nothing", () =>
    memory(
      Effect.gen(function* () {
        const { db, project, main } = yield* setup
        yield* db.insertSession(session(B), project, { cwd: "/w", task: "b", parentSessionId: main })
        const sql = yield* SqlClient.SqlClient
        assert.isUndefined(yield* db.insertSend(B, "hello", undefined, A))
        assert.deepStrictEqual(yield* sql`SELECT 1 FROM inbox WHERE kind = 'send' AND sender_session_id = ${A}`, [])
        assert.isDefined(yield* db.insertSend(B, "from its creator", undefined, main))
      }),
    ),
  )

  it.effect("a session whose parent has ended sends to the entry session, not to that parent", () =>
    memory(
      Effect.gen(function* () {
        const { db, project, main } = yield* setup
        yield* db.insertSession(session(B), project, { cwd: "/w", task: "b", parentSessionId: A })
        yield* db.updateSession(A, { metadata: { archived: true, removed: true } })
        assert.isDefined(yield* db.insertSend(main, "to the entry", undefined, B))
        assert.isUndefined(yield* db.insertSend(A, "to the ended parent", undefined, B))
        const creator = yield* db.creatorOf(B)
        assert.deepStrictEqual(creator, { id: main, label: "the main agent" })
        const prompt = sessionSystemPrompt({
          id: B,
          projectDir: "/w",
          vibest: ["vibest"],
          preferences: "",
          memories: "",
          creator,
        })
        assert.include(prompt, `send ${main} --`)
        assert.notInclude(prompt, `send ${A} --`)
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
        assert.strictEqual((yield* db.setInboxStatus(main, [sent.id], "dropped")).length, 0)
      }),
    ),
  )

  it.effect("a send in flight to a main agent that does not poll ends failed with one notice to its sender", () =>
    memory(
      Effect.gen(function* () {
        const { db, main } = yield* setup
        const sent = (yield* db.insertSend(main, "hello", undefined, A))!
        yield* db.claim(main, [sent.id])
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
        yield* db.claim(main, [sent.id])
        yield* db.failLeased(main, [sent.id])
        assert.strictEqual((yield* db.pendingInbox(A)).length, 1)
      }),
    ),
  )

  it.effect("when the sender is gone the notice goes to the sender's creator, not the recipient's", () =>
    memory(
      Effect.gen(function* () {
        const { db, project, main } = yield* setup
        yield* db.insertSession(session(X), project, { cwd: "/w", task: "x", parentSessionId: main })
        yield* db.insertSession(session(B), project, { cwd: "/w", task: "b", parentSessionId: A })
        const sent = (yield* db.insertSend(B, "hello", undefined, A))!
        yield* db.updateSession(A, { metadata: { archived: true, removed: true } })
        yield* db.claim(B, [sent.id])
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
        assert.isUndefined(yield* db.sendToOrigin(B, "eeeeeeee", "hi"))
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

  it.effect("a send with no sender session is put back for the next poll when its delivery is cut", () =>
    memory(
      Effect.gen(function* () {
        const { db, project, main } = yield* setup
        const first = (yield* db.insertSend(main, "one"))!
        yield* db.claim(main, [first.id])
        yield* db.recoverDelivering([], () => "")
        assert.deepStrictEqual(
          (yield* db.coordinatorPending(project)).map((r) => r.message),
          ["one"],
        )
        yield* db.claim(main, [first.id])
        yield* db.failLeased(main, [first.id])
        assert.deepStrictEqual(
          (yield* db.coordinatorPending(project)).map((r) => r.message),
          ["one"],
        )
      }),
    ),
  )
})
