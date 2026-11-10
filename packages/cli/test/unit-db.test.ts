import { Database } from "bun:sqlite"
import url from "node:url"

import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { APPLICATION_ID, Db, encodeAddress, SCHEMA_VERSION } from "@vibest/core/db"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { ID } from "@vibest/schema/id"
import { Cause, Effect, Exit, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { tempDirectory, TURNS, projectOf } from "./fakes.ts"
import { database, session, place } from "./unit-helpers.ts"

describe("Db", () => {
  const fresh = <A, E>(program: Effect.Effect<A, E, Db>) => program.pipe(Effect.provide(database(":memory:")))

  it.effect(
    "one coordinator row per project; fresh starts a new main session and ends the old one; a harness switch clears the conversation; reports match id and harness",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const first = yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, place)
        assert.isNull(first.harnessSessionId)
        yield* db.reportCoordinatorSession(first.sessionId, "pi", "s1")
        const again = yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, place)
        assert.strictEqual(again.sessionId, first.sessionId)
        assert.strictEqual(again.harnessSessionId, "s1")
        yield* db.reportCoordinatorSession(first.sessionId, "cursor", "nested")
        yield* db.reportCoordinatorSession("0e0e0000-0e0e-40e0-80e0-0e0e00000e0e", "pi", "x")
        assert.strictEqual(
          (yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, place)).harnessSessionId,
          "s1",
        )
        const renewed = yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", true, place)
        assert.notStrictEqual(renewed.sessionId, first.sessionId)
        assert.isNull(renewed.harnessSessionId)
        yield* db.reportCoordinatorSession(renewed.sessionId, "pi", "s4")
        assert.isNull((yield* db.coordinatorLaunch(yield* projectOf("r"), "claude", false, place)).harnessSessionId)
        yield* db.reportCoordinatorSession(renewed.sessionId, "claude", "c1")
        assert.strictEqual(
          (yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, place)).sessionId,
          renewed.sessionId,
        )
        assert.isNull((yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, place)).harnessSessionId)
        yield* db.reportCoordinatorSession(renewed.sessionId, "pi", "s6")
        yield* db.reportCoordinatorSession(renewed.sessionId, "pi", "s7")
        assert.strictEqual(
          (yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, place)).harnessSessionId,
          "s7",
        )
        const sql = yield* SqlClient.SqlClient
        const [old] = yield* sql<{
          endedAt: number | null
        }>`SELECT ended_at FROM session WHERE id = ${first.sessionId}`
        assert.isNotNull(old!.endedAt)
        const ends = yield* sql<{
          reason: string
        }>`SELECT json_extract(data, '$.reason') AS reason FROM event WHERE session_id = ${first.sessionId} AND type = 'process.end'`
        assert.strictEqual(ends.at(-1)?.reason, "archived")
        const [project] = yield* sql<{
          main: string
        }>`SELECT entry_session_id AS main FROM project WHERE id = ${yield* projectOf("r")}`
        assert.strictEqual(project!.main, renewed.sessionId)
      }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:")), Layer.provide(Bus.layer)))),
  )

  const memory = <A, E>(program: Effect.Effect<A, E, Db | SqlClient.SqlClient>) =>
    program.pipe(
      Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:")), Layer.provide(Bus.layer))),
    )

  it.effect(
    "rescheduleSource: the open round's input, the trailing delivered user or parent run, and the parent id; an empty open round resends the trailing same-sender batch, not an earlier turn",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Db
          const sql = yield* SqlClient.SqlClient
          const parent = yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, place)
          yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
            cwd: "/w",
            task: "do it",
            parentSessionId: parent.sessionId,
          })
          yield* db.beginUserTurn("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "typed", { turnPromptedAt: 1 })
          const inbox = (kind: string, senderId: string | null, content: string, status: string) =>
            sql`INSERT INTO inbox (recipient_session_id, kind, sender_session_id, content, status)
          VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ${kind}, ${senderId}, ${content}, ${status})`
          yield* inbox("send", parent.sessionId, "from parent", "delivered")
          yield* inbox("send", null, "later send", "delivered")
          yield* inbox("notice", parent.sessionId, "a notice", "delivered")
          yield* inbox("send", null, "still pending", "pending")
          assert.deepStrictEqual(yield* db.rescheduleSource("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), {
            working: "typed",
            delivered: "later send",
            parentSessionId: parent.sessionId,
          })
          yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { turnState: "completed" })
          yield* db.beginUserTurn("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "", { turnPromptedAt: 2 })
          assert.strictEqual((yield* db.rescheduleSource("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).working, "")
          yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { turnState: "completed" })
          assert.deepStrictEqual(yield* db.rescheduleSource("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), {
            working: "",
            delivered: "later send",
            parentSessionId: parent.sessionId,
          })
          assert.deepStrictEqual(yield* db.rescheduleSource("00000000-0000-4000-8000-000000000000"), {
            working: "",
            delivered: "",
            parentSessionId: undefined,
          })

          yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"), {
            cwd: "/w",
            task: "do it",
            parentSessionId: parent.sessionId,
          })
          yield* db.updateSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { turnState: "open", turnPromptedAt: 1 })
          yield* db.updateSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { turnState: "completed" })
          yield* db.updateSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { turnState: "open", turnPromptedAt: 3 })
          const follow = yield* db.insertSend("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "add tests")
          yield* db.setInboxStatus([follow!.id], "delivered")
          yield* db.updateSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { turnState: "completed" })
          yield* db.updateSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { turnState: "open", turnPromptedAt: 5 })
          const row = (kind: string, senderId: string | null, content: string, status = "delivered") =>
            sql`INSERT INTO inbox (recipient_session_id, kind, sender_session_id, content, status)
            VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ${kind}, ${senderId}, ${content}, ${status})`
          yield* row("send", parent.sessionId, "from parent")
          yield* row("send", null, "and docs")
          assert.strictEqual((yield* db.rescheduleSource("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).delivered, "and docs")
          yield* row("send", null, "also types")
          assert.deepStrictEqual(yield* db.rescheduleSource("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), {
            working: "",
            delivered: "and docs\n\nalso types",
            parentSessionId: parent.sessionId,
          })
          yield* row("send", null, "still pending", "pending")
          yield* row("notice", parent.sessionId, "a notice")
          assert.strictEqual(
            (yield* db.rescheduleSource("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).delivered,
            "and docs\n\nalso types",
          )
        }),
      ),
  )

  it.effect(
    "a turn's input is the rows delivered while it is open, or its task; the next turn with none is empty",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Db
          const sql = yield* SqlClient.SqlClient
          const round = (id: string) =>
            sql<{
              inboxId: number | null
              input: string
            }>`SELECT inbox_id, input FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND status = 'working'`
          yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
            cwd: "/w",
            task: "do it",
          })
          yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { turnState: "open", turnPromptedAt: 5 })
          assert.strictEqual(
            (yield* round("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))[0]!.inboxId,
            null,
            "opening the turn does not hand the task over; its handover does",
          )
          yield* db.linkTask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          const [task] = yield* sql<{
            id: number
          }>`SELECT id FROM inbox WHERE recipient_session_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`
          const [opened] = yield* round("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          assert.strictEqual(opened!.inboxId, task!.id)
          assert.strictEqual(opened!.input, "do it")
          yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { turnState: "completed" })
          yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { turnState: "open", turnPromptedAt: 9 })
          const [again] = yield* round("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          assert.isNull(again!.inboxId)
          assert.strictEqual(again!.input, "")

          yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"))
          const sent = yield* db.insertSend("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "ping")
          yield* db.updateSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { turnState: "open", turnPromptedAt: 3 })
          yield* db.setInboxStatus([sent!.id], "delivered")
          const [sendRound] = yield* round("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
          assert.strictEqual(sendRound!.inboxId, sent!.id)
          assert.strictEqual(sendRound!.input, "ping")

          yield* db.insertSession(session("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), yield* projectOf("r"))
          const first = yield* db.insertSend("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "add a test")
          const second = yield* db.insertSend("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "also update the readme")
          yield* db.updateSession("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { turnState: "open", turnPromptedAt: 4 })
          yield* db.setInboxStatus([first!.id, second!.id], "delivered")
          const [merged] = yield* round("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
          assert.strictEqual(merged!.inboxId, second!.id)
          assert.strictEqual(merged!.input, "add a test\n\nalso update the readme")
          yield* db.updateSession("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { turnState: "completed" })
          const third = yield* db.insertSend("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "and the docs")
          yield* db.updateSession("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { turnState: "open", turnPromptedAt: 6 })
          yield* db.setInboxStatus([third!.id], "delivered")
          const [next] = yield* round("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
          assert.strictEqual(next!.inboxId, third!.id)
          assert.strictEqual(next!.input, "and the docs")
        }),
      ),
  )

  it.effect("beginUserTurn is false when a round is already working and leaves that input", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"))
        assert.isTrue(yield* db.beginUserTurn("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "kept", { turnPromptedAt: 1 }))
        assert.isFalse(
          yield* db.beginUserTurn("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "dropped", { turnPromptedAt: 2 }),
        )
        assert.deepStrictEqual(
          yield* sql<{
            input: string
          }>`SELECT input FROM ${sql.literal(TURNS)} m WHERE session_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`,
          [{ input: "kept" }],
        )
      }),
    ),
  )

  it.effect("the limit counts non-stopped rows", () =>
    fresh(
      Effect.gen(function* () {
        const db = yield* Db
        assert.isTrue(
          yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), { max: 1 }),
        )
        assert.isFalse(
          yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"), { max: 1 }),
        )
        yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
          status: "unknown",
          startedAt: 1,
          exitedAt: 1,
        })
        assert.isTrue(
          yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"), { max: 1 }),
        )
        assert.deepStrictEqual(
          (yield* db.listSessions()).map((w) => w.id),
          ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        )
      }),
    ),
  )

  it.effect(
    "the task is the first inbox row; the open turn is the message row with no ended_at; status is memory only",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
          cwd: "/w",
          task: "do it",
        })
        assert.deepStrictEqual(
          yield* sql`SELECT kind, content, status FROM inbox WHERE recipient_session_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`,
          [{ kind: "task", content: "do it", status: "delivered" }],
        )
        assert.deepStrictEqual(yield* db.pendingInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), [])
        assert.strictEqual((yield* db.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!.turnState, "none")
        assert.isFalse(yield* db.turnTaken("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "no open turn")
        yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
          status: "working",
          turnState: "open",
          turnPromptedAt: 5,
        })
        assert.isFalse(yield* db.turnTaken("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "task not handed over yet")
        assert.strictEqual(yield* db.untakenTask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "do it")
        yield* db.linkTask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        assert.isUndefined(yield* db.untakenTask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
        assert.isTrue(
          yield* db.turnTaken("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          "the task delivered into the open turn is the stored proof it was taken up",
        )
        assert.strictEqual(
          (yield* sql<{
            status: string
          }>`SELECT status FROM ${sql.literal(TURNS)} m WHERE session_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`)[0]
            ?.status,
          "working",
        )
        assert.deepInclude(yield* db.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), {
          status: "working",
          turnState: "open",
          turnPromptedAt: 5,
        })
        yield* db.finishTurn(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          { status: "completed", output: "the answer", failure: { message: "late" } },
          { turnState: "completed" },
          {
            sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            kind: "result",
            message: "<summary>done</summary>",
            details: { summary: "done" },
          },
        )
        assert.strictEqual((yield* db.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!.turnState, "completed")
        yield* db.closeTurn("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "interrupted", {})
        assert.strictEqual((yield* db.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!.turnState, "completed")
        assert.notProperty(
          (yield* sql`SELECT * FROM session WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`)[0],
          "status",
        )
      }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:")), Layer.provide(Bus.layer)))),
  )

  it.effect("a result goes to the parent while it has not ended, then to the project's current main session", () =>
    Effect.gen(function* () {
      const db = yield* Db
      const sql = yield* SqlClient.SqlClient
      yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"))
      yield* db.insertSession(session("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), yield* projectOf("r"))
      yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"))
      yield* sql`UPDATE session SET parent_session_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', report_to_session_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`
      yield* sql`UPDATE project SET entry_session_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'`
      const recipient = Effect.flatMap(
        sql<{
          recipient: string
        }>`SELECT recipient_session_id AS recipient FROM inbox WHERE kind = 'result' ORDER BY id DESC LIMIT 1`,
        (rows) => Effect.succeed(rows[0]?.recipient),
      )
      const round = (summary: string) =>
        Effect.gen(function* () {
          yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { turnState: "open", turnPromptedAt: 1 })
          yield* db.finishTurn(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            { status: "completed" },
            { turnState: "completed" },
            {
              sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              kind: "result",
              message: summary,
              details: { summary },
            },
          )
        })
      yield* round("one")
      assert.strictEqual(yield* recipient, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
      yield* sql`UPDATE session SET ended_at = 1 WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'`
      yield* round("two")
      assert.strictEqual(yield* recipient, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")
    }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:")), Layer.provide(Bus.layer)))),
  )

  it.effect("sessionBriefs: the task is the session's task row; latest is its newest turn", () =>
    Effect.gen(function* () {
      const db = yield* Db
      const sql = yield* SqlClient.SqlClient
      const turn = (id: string, at: number, end?: { at: number; status: string; output?: string; result?: string }) =>
        Effect.gen(function* () {
          const [start] = yield* sql<{ id: number }>`INSERT INTO event (at, session_id, type, data)
            VALUES (${at}, ${id}, 'turn.start', '{"by":"delivery"}') RETURNING id`
          if (end === undefined) return
          const data = JSON.stringify({
            status: end.status,
            ...(end.output === undefined ? {} : { output: end.output }),
          })
          const [last] = yield* sql<{ id: number }>`INSERT INTO event (at, session_id, type, turn_id, data)
            VALUES (${end.at}, ${id}, 'turn.end', ${start!.id}, ${data}) RETURNING id`
          if (end.result !== undefined)
            yield* sql`INSERT INTO inbox (recipient_session_id, kind, sender_session_id, content, result_event_id, status)
              VALUES (${id}, 'result', ${id}, ${end.result}, ${last!.id}, 'dropped')`
        })
      yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"))
      yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
        cwd: "/w",
        task: "from parent",
        parentSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      })
      yield* db.insertSend("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "later send")
      yield* turn("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1, {
        at: 10,
        status: "completed",
        result: "<summary>old summary</summary>",
      })
      yield* turn("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 2, { at: 20, status: "failed", output: "new line\nmore" })
      yield* db.insertSession(session("dddddddd-dddd-4ddd-8ddd-dddddddddddd"), yield* projectOf("r"), {
        cwd: "/w",
        task: "do it",
      })
      yield* db.insertSession(session("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"), yield* projectOf("r"))
      yield* db.updateSession("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { turnState: "open", turnPromptedAt: 5 })
      yield* db.insertSession(session("ffffffff-ffff-4fff-8fff-ffffffffffff"), yield* projectOf("r"))
      yield* turn("ffffffff-ffff-4fff-8fff-ffffffffffff", 3, { at: 7, status: "interrupted", output: "fallback\nrest" })
      yield* db.insertSession(session("11111111-1111-4111-8111-111111111111"), yield* projectOf("r"))
      yield* turn("11111111-1111-4111-8111-111111111111", 4, {
        at: 8,
        status: "lost",
        output: "hidden",
        result: "<summary></summary>",
      })

      const reportedId = "22222222-2222-4222-8222-222222222222"
      yield* db.insertSession(session(reportedId), yield* projectOf("r"))
      const [reported] = yield* sql<{ id: number }>`INSERT INTO event (at, session_id, type, data)
        VALUES (30, ${reportedId}, 'turn.reported', ${JSON.stringify({ harness: "pi", text: "new line\nmore" })}) RETURNING id`
      const [start] = yield* sql<{ id: number }>`INSERT INTO event (at, session_id, type, data)
        VALUES (29, ${reportedId}, 'turn.start', '{}') RETURNING id`
      yield* sql`INSERT INTO event (at, session_id, type, turn_id, data)
        VALUES (31, ${reportedId}, 'turn.end', ${start!.id}, ${JSON.stringify({ status: "failed", report: reported!.id })})`

      const briefs = yield* db.sessionBriefs([
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        reportedId,
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        "ffffffff-ffff-4fff-8fff-ffffffffffff",
        "11111111-1111-4111-8111-111111111111",
        "00000000-0000-4000-8000-000000000000",
      ])
      assert.deepStrictEqual(briefs.get("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), {
        task: "from parent",
        latest: { status: "failed", summary: "new line", endedAt: 20 },
      })
      assert.deepStrictEqual(briefs.get(reportedId)?.latest, { status: "failed", summary: "new line", endedAt: 31 })
      assert.deepStrictEqual(briefs.get("dddddddd-dddd-4ddd-8ddd-dddddddddddd"), { task: "do it", latest: null })
      assert.deepStrictEqual(briefs.get("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"), {
        task: null,
        latest: { status: "working", summary: "", endedAt: null },
      })
      assert.deepStrictEqual(briefs.get("ffffffff-ffff-4fff-8fff-ffffffffffff"), {
        task: null,
        latest: { status: "interrupted", summary: "fallback", endedAt: 7 },
      })
      assert.deepStrictEqual(briefs.get("11111111-1111-4111-8111-111111111111"), {
        task: null,
        latest: { status: "lost", summary: "", endedAt: 8 },
      })
      assert.isUndefined(briefs.get("00000000-0000-4000-8000-000000000000"))
      assert.strictEqual((yield* db.sessionBriefs([])).size, 0)
    }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:")), Layer.provide(Bus.layer)))),
  )
  it.effect("a result with no coordinator is dropped; a claim takes a pending row once", () =>
    fresh(
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.insertSession(
          session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { turnState: "open" }),
          yield* projectOf("r"),
        )
        const dropped = yield* db.finishTurn(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          { status: "completed" },
          { turnState: "completed", status: "idle" },
          {
            sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            kind: "result",
            message: "m",
            details: { status: "completed" },
          },
        )
        assert.strictEqual(dropped.status, "dropped")
        assert.strictEqual((yield* db.latestInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "result"))!.status, "dropped")
        yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, place)
        const row = yield* db.insertInbox({
          sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          kind: "report",
          message: "hi",
          details: {},
        })
        assert.strictEqual(row.status, "pending")
        const guard = {
          projectId: (yield* db.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!.projectId,
          runtime: RUNTIME,
          address: encodeAddress(place.address),
        }
        assert.deepStrictEqual(yield* db.claim([row.id], guard), [row.id])
        assert.deepStrictEqual(yield* db.claim([row.id], guard), [])
        yield* db.setInboxStatus([row.id], "delivered", "sending")
        assert.strictEqual(
          (yield* db.latestInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "report"))!.status,
          "delivered",
        )
        yield* db.insertInbox({
          sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          kind: "notice",
          message: "n",
          details: {},
        })
        yield* db.clearCoordinator(RUNTIME, place.address)
        assert.strictEqual((yield* db.latestInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "notice"))!.status, "dropped")
      }),
    ),
  )

  const fileAt = (dir: string, name: string) => Path.Path.pipe(Effect.map((path) => path.join(dir, name)))

  const header = (file: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return {
        applicationId: (yield* sql<{ applicationId: number }>`PRAGMA application_id`)[0]?.applicationId ?? 0,
        userVersion: (yield* sql<{ userVersion: number }>`PRAGMA user_version`)[0]?.userVersion ?? 0,
        objects: (yield* sql<{ n: number }>`SELECT count(*) AS n FROM sqlite_master`)[0]?.n ?? 0,
      }
    }).pipe(Effect.provide(Platform.sqlite(file)))

  const writeSql = (file: string, statements: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      for (const statement of statements) yield* sql.unsafe(statement)
    }).pipe(Effect.provide(Platform.sqlite(file)))

  const refusal = (file: string) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.void.pipe(Effect.provide(database(file))))
      assert.isTrue(Exit.isFailure(exit))
      return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
    })

  const brokenInstall = (file: string, how: "fail" | "interrupt") =>
    Db.layer.pipe(
      Layer.provide(
        Layer.effect(
          SqlClient.SqlClient,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return new Proxy(sql, {
              get(target, prop, receiver) {
                if (prop !== "unsafe") return Reflect.get(target, prop, receiver)
                return (statement: string, params?: ReadonlyArray<unknown>) =>
                  statement.includes("event_no_update")
                    ? how === "interrupt"
                      ? Effect.interrupt
                      : Effect.fail(new Error("injected schema failure"))
                    : target.unsafe(statement, params)
              },
            }) as SqlClient.SqlClient
          }),
        ).pipe(Layer.provide(Platform.sqlite(file))),
      ),
      Layer.provide(Bus.layer),
    )

  it.effect("a failed or interrupted install rolls back, then a later open initializes", () =>
    Effect.gen(function* () {
      const dir = yield* tempDirectory("vibest-schema-rollback-")
      for (const how of ["fail", "interrupt"] as const) {
        const file = yield* fileAt(dir, `${how}.db`)
        const exit = yield* Effect.exit(Effect.void.pipe(Effect.provide(brokenInstall(file, how))))
        assert.isTrue(
          how === "interrupt" ? Exit.hasInterrupts(exit) : Exit.isFailure(exit) && !Exit.hasInterrupts(exit),
        )
        assert.deepStrictEqual(yield* header(file), { applicationId: 0, userVersion: 0, objects: 0 })
        yield* Effect.gen(function* () {
          const db = yield* Db
          assert.isTrue(yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r")))
          assert.match((yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, place)).sessionId, ID)
        }).pipe(Effect.provide(database(file)))
        assert.strictEqual((yield* header(file)).applicationId, APPLICATION_ID)
        assert.strictEqual((yield* header(file)).userVersion, SCHEMA_VERSION)
      }
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("an incomplete file is rejected and left byte-identical", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDirectory("vibest-schema-partial-")
      const pragma = [`PRAGMA application_id = ${APPLICATION_ID}`, `PRAGMA user_version = ${SCHEMA_VERSION}`]
      const tables = [
        "CREATE TABLE project (id TEXT PRIMARY KEY) STRICT",
        "CREATE TABLE project_repository (project_id TEXT, path TEXT) STRICT",
        "CREATE TABLE session (id TEXT PRIMARY KEY, project_id INTEGER, parent_session_id TEXT, machine TEXT, directory TEXT) STRICT",
        "CREATE TABLE inbox (id INTEGER PRIMARY KEY) STRICT",
        "CREATE TABLE event (id INTEGER PRIMARY KEY) STRICT",
      ]
      const cases = [
        [
          "missing-index.db",
          [
            ...pragma,
            ...tables,
            "CREATE INDEX project_repository_project ON project_repository (project_id)",
            "CREATE INDEX session_project ON session (project_id)",
            "CREATE INDEX session_parent ON session (parent_session_id)",
            "CREATE INDEX session_live ON session (machine, directory)",
          ],
          "missing inbox_status",
        ],
      ] as const
      for (const [name, statements, expected] of cases) {
        const file = yield* fileAt(dir, name)
        yield* writeSql(file, statements)
        const before = yield* fs.readFile(file)
        const pretty = yield* refusal(file)
        assert.include(pretty, "SchemaMismatch")
        assert.include(pretty, expected)
        assert.deepStrictEqual(yield* fs.readFile(file), before)
        assert.isFalse(yield* fs.exists(`${file}-wal`))
        assert.include(yield* refusal(file), expected)
        assert.deepStrictEqual(yield* fs.readFile(file), before)
      }
      const dropped = yield* fileAt(dir, "missing-table.db")
      yield* Effect.void.pipe(Effect.provide(database(dropped)))
      yield* writeSql(dropped, ["DROP INDEX project_repository_project", "DROP TABLE project_repository"])
      const droppedBytes = yield* fs.readFile(dropped)
      assert.include(yield* refusal(dropped), "missing project_repository")
      assert.deepStrictEqual(yield* fs.readFile(dropped), droppedBytes)
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a file of the shape before this baseline (version 1 too, no event table) is refused, naming its path and how to move it aside, since vibest never migrates one",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* fileAt(yield* tempDirectory("vibest-schema-v1-"), "vibest.db")
        yield* writeSql(file, [
          `PRAGMA application_id = ${APPLICATION_ID}`,
          "PRAGMA user_version = 1",
          "CREATE TABLE project (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, main_session_id TEXT)",
          "CREATE TABLE session (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL)",
          "CREATE TABLE inbox (id INTEGER PRIMARY KEY)",
        ])
        assert.strictEqual(SCHEMA_VERSION, 1)
        const before = yield* fs.readFile(file)
        const pretty = yield* refusal(file)
        assert.include(pretty, `${file} is from an older vibest`)
        assert.include(pretty, "vibest never migrates a database")
        assert.include(pretty, "the sessions, results and queued messages it holds are lost")
        assert.notInclude(pretty, "migration script")
        assert.deepStrictEqual(yield* fs.readFile(file), before)
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a foreign database with user_version 1, or ours at a newer user_version, is refused without changing its bytes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = yield* fileAt(yield* tempDirectory("vibest-schema-foreign-"), "other.db")
        yield* writeSql(file, [
          "CREATE TABLE other (id INTEGER PRIMARY KEY, note TEXT)",
          "INSERT INTO other (id, note) VALUES (1, 'keep-me')",
          "PRAGMA user_version = 1",
        ])
        const before = yield* fs.readFile(file)
        const pretty = yield* refusal(file)
        assert.match(pretty, /SchemaMismatch/)
        assert.match(pretty, /application_id 0x0, v1/)
        assert.notMatch(pretty, /0x76696265/)
        assert.include(pretty, `${file} is not this vibest's schema`)
        assert.deepStrictEqual(yield* fs.readFile(file), before)
        assert.isFalse(yield* fs.exists(`${file}-wal`))
        assert.isFalse(yield* fs.exists(`${file}-shm`))
        assert.match(yield* refusal(file), /application_id 0x0, v1/)
        assert.deepStrictEqual(yield* fs.readFile(file), before)
        const reader = new Database(file, { readonly: true })
        assert.strictEqual((reader.query("SELECT note FROM other").get() as { note: string } | null)?.note, "keep-me")
        reader.close()

        const newer = yield* fileAt(yield* tempDirectory("vibest-schema-newer-"), "vibest.db")
        yield* Effect.void.pipe(Effect.provide(database(newer)))
        yield* writeSql(newer, ["PRAGMA user_version = 99"])
        const newerBytes = yield* fs.readFile(newer)
        const newerSaid = yield* refusal(newer)
        assert.match(newerSaid, /SchemaMismatch/)
        assert.include(newerSaid, `${newer} is not this vibest's schema`)
        assert.include(
          newerSaid,
          `for f in ${newer} ${newer}-wal ${newer}-shm; do [ -e "$f" ] && mv "$f" "$f.old"; done`,
        )
        assert.deepStrictEqual(yield* fs.readFile(newer), newerBytes)
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a hot foreign WAL is refused without checkpointing the database or WAL (the writer keeps its db reachable: Bun's GC would checkpoint it)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* tempDirectory("vibest-schema-hot-")
        const file = yield* fileAt(dir, "hot.db")
        const ready = yield* fileAt(dir, "ready")
        const maker = yield* fileAt(dir, "maker.ts")
        const keepDbAlive = "setInterval(() => db, 1000)"
        yield* fs.writeFileString(
          maker,
          [
            'import { Database } from "bun:sqlite"',
            'import { writeFileSync } from "node:fs"',
            "const db = new Database(process.argv[2])",
            'db.exec("PRAGMA journal_mode = WAL")',
            'db.exec("BEGIN")',
            'db.exec("CREATE TABLE other (id INTEGER PRIMARY KEY, note TEXT)")',
            "db.exec(\"INSERT INTO other VALUES (1, 'keep-me')\")",
            'for (let i = 0; i < 400; i++) db.run("INSERT INTO other (note) VALUES (?)", ["x".repeat(80)])',
            'db.exec("PRAGMA user_version = 1")',
            'db.exec("COMMIT")',
            "writeFileSync(process.argv[3], 'ok')",
            keepDbAlive,
            "",
          ].join("\n"),
        )
        const proc = Bun.spawn(["bun", maker, file, ready], { stdout: "pipe", stderr: "pipe" })
        yield* Effect.gen(function* () {
          while (!(yield* fs.exists(ready))) {
            if (proc.exitCode !== null) return yield* Effect.die("hot wal helper exited before it was ready")
            yield* Effect.promise(() => Bun.sleep(20))
          }
        })
        proc.kill(9)
        yield* Effect.promise(() => proc.exited)
        const dbBefore = yield* fs.readFile(file)
        const walBefore = yield* fs.readFile(`${file}-wal`)
        assert.isTrue(walBefore.length > 0)
        const pretty = yield* refusal(file)
        assert.include(pretty, "SchemaMismatch")
        assert.include(pretty, "application_id 0x0, v1")
        assert.deepStrictEqual(yield* fs.readFile(file), dbBefore)
        assert.deepStrictEqual(yield* fs.readFile(`${file}-wal`), walBefore)
        const reader = new Database(file, { readonly: true })
        assert.strictEqual(
          (reader.query("SELECT note FROM other WHERE id = 1").get() as { note: string } | null)?.note,
          "keep-me",
        )
        reader.close()
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("sessionAt finds the one live session at that runtime, machine and terminal", () =>
    fresh(
      Effect.gen(function* () {
        const db = yield* Db
        const project = yield* projectOf("r")
        const here = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        const terminal = { machine: "local", id: "pane-a" }
        yield* db.insertSession(
          session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
            address: { machine: "local", id: "pane-b" },
            createdAt: 0,
          }),
          project,
        )
        yield* db.insertSession(
          session("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { runtime: "other", address: terminal, createdAt: 0 }),
          project,
        )
        yield* db.insertSession(
          session("dddddddd-dddd-4ddd-8ddd-dddddddddddd", {
            address: { machine: "remote", id: "pane-a" },
            createdAt: 0,
          }),
          project,
        )
        yield* db.insertSession(
          session("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { address: terminal, exitedAt: 5, createdAt: 0 }),
          project,
        )
        yield* db.insertSession(session(here, { address: terminal, createdAt: 1 }), project)
        assert.strictEqual(yield* db.sessionAt(RUNTIME, terminal), here)
        assert.isUndefined(yield* db.sessionAt(RUNTIME, { machine: "local", id: "missing" }))
      }),
    ),
  )

  it.effect("two empty opens both initialize", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDirectory("vibest-schema-race-")
      const file = yield* fileAt(dir, "vibest.db")
      const script = yield* fileAt(dir, "open.ts")
      const dbModule = url.fileURLToPath(new URL("../../../packages/core/src/db.ts", import.meta.url))
      const busModule = url.fileURLToPath(new URL("../../../packages/core/src/bus.ts", import.meta.url))
      const platformModule = url.fileURLToPath(new URL("../src/platform/bun.ts", import.meta.url))
      yield* fs.writeFileString(
        script,
        [
          'import { Effect, Layer } from "effect"',
          `import { Bus } from ${JSON.stringify(busModule)}`,
          `import { Db } from ${JSON.stringify(dbModule)}`,
          `import * as Platform from ${JSON.stringify(platformModule)}`,
          "await Effect.runPromise(Effect.void.pipe(Effect.provide(Db.layer.pipe(Layer.provide(Platform.sqlite(process.argv[2]!)), Layer.provide(Bus.layer)))))",
          "",
        ].join("\n"),
      )
      const spawn = () => Bun.spawn(["bun", script, file], { stdout: "pipe", stderr: "pipe" })
      const [a, b] = [spawn(), spawn()]
      const [codeA, codeB, errA, errB] = yield* Effect.promise(() =>
        Promise.all([a.exited, b.exited, new Response(a.stderr).text(), new Response(b.stderr).text()]),
      )
      assert.deepStrictEqual([codeA, errA, codeB, errB], [0, "", 0, ""])
      assert.strictEqual((yield* header(file)).applicationId, APPLICATION_ID)
    }).pipe(Effect.provide(Platform.services)),
  )
})
