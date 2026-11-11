import { Database } from "bun:sqlite"
import url from "node:url"

import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { applyOnly, type Migration, migrations } from "@vibest/core/database/migration"
import { APPLICATION_ID, Db, encodeAddress } from "@vibest/core/db"
import { makeJournal } from "@vibest/core/journal"
import { PROJECTION_VERSION } from "@vibest/core/projectors"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Catalog, CATALOG_VERSION, type FactType } from "@vibest/schema/event"
import { ID } from "@vibest/schema/id"
import { Cause, Effect, Exit, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { tempDirectory, EXECUTIONS, projectOf } from "./fakes.ts"
import { database, session, place } from "./unit-helpers.ts"

const fact = (
  type: FactType,
  input: { readonly sessionId?: string; readonly projectId?: string; readonly at?: number; readonly data: object },
) =>
  Effect.gen(function* () {
    const journal = yield* makeJournal(() => Effect.void)
    return yield* journal.commit(journal.emit(Catalog[type] as never, input as never))
  }).pipe(Effect.orDie)

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
        }>`SELECT end_reason AS reason FROM process WHERE session_id = ${first.sessionId} AND ended_at IS NOT NULL
          ORDER BY ended_at, id`
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
    "rescheduleSource: the open execution's input, the trailing delivered user or parent run, and the parent id; an empty open execution resends the trailing same-sender batch, not an earlier execution",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Db
          const parent = yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, place)
          yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
            cwd: "/w",
            task: "do it",
            parentSessionId: parent.sessionId,
          })
          yield* db.startObserved("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "typed", 1)
          const inbox = (kind: string, senderId: string | null, content: string, status: string) =>
            fact("inbox.queued", {
              sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              data: {
                kind,
                recipient: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                ...(senderId === null ? {} : { sender: senderId }),
                content,
                status,
              },
            })
          yield* inbox("send", parent.sessionId, "from parent", "delivered")
          yield* inbox("send", null, "later send", "delivered")
          yield* inbox("notice", parent.sessionId, "a notice", "delivered")
          yield* inbox("send", null, "still pending", "pending")
          assert.deepStrictEqual(yield* db.rescheduleSource("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), {
            working: "typed",
            delivered: "a notice",
            parentSessionId: parent.sessionId,
            since: 1,
          })
          yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { executionState: "completed" })
          yield* db.beginExecution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 2)
          assert.strictEqual((yield* db.rescheduleSource("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).working, "")
          yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { executionState: "completed" })
          assert.deepStrictEqual(yield* db.rescheduleSource("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), {
            working: "",
            delivered: "a notice",
            parentSessionId: parent.sessionId,
            since: 2,
          })
          assert.deepStrictEqual(yield* db.rescheduleSource("00000000-0000-4000-8000-000000000000"), {
            working: "",
            delivered: "",
            parentSessionId: undefined,
            since: 0,
          })

          yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"), {
            cwd: "/w",
            task: "do it",
            parentSessionId: parent.sessionId,
          })
          yield* db.updateSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
            executionState: "open",
            executionPromptedAt: 1,
          })
          yield* db.updateSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { executionState: "completed" })
          yield* db.updateSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
            executionState: "open",
            executionPromptedAt: 3,
          })
          const follow = yield* db.insertSend("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "add tests")
          yield* db.setInboxStatus("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", [follow!.id], "delivered")
          yield* db.updateSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { executionState: "completed" })
          yield* db.updateSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
            executionState: "open",
            executionPromptedAt: 5,
          })
          const row = (kind: string, senderId: string | null, content: string, status = "delivered") =>
            fact("inbox.queued", {
              sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              data: {
                kind,
                recipient: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                ...(senderId === null ? {} : { sender: senderId }),
                content,
                status,
              },
            })
          yield* row("send", parent.sessionId, "from parent")
          yield* row("send", null, "and docs")
          assert.strictEqual((yield* db.rescheduleSource("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).delivered, "and docs")
          yield* row("send", null, "also types")
          assert.deepStrictEqual(yield* db.rescheduleSource("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), {
            working: "",
            delivered: "and docs\n\nalso types",
            parentSessionId: parent.sessionId,
            since: 5,
          })
          yield* row("send", null, "still pending", "pending")
          yield* row("notice", parent.sessionId, "a notice", "pending")
          assert.strictEqual(
            (yield* db.rescheduleSource("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).delivered,
            "and docs\n\nalso types",
          )
        }),
      ),
  )

  it.effect(
    "an execution's input is the rows delivered while it is open, or its task; the next execution with none is empty",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Db
          const sql = yield* SqlClient.SqlClient
          const execution = (id: string) =>
            sql<{
              inboxId: number | null
              input: string
            }>`SELECT inbox_id, input FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = ${id} AND status = 'working'`
          yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
            cwd: "/w",
            task: "do it",
          })
          yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
            executionState: "open",
            executionPromptedAt: 5,
          })
          assert.strictEqual(
            (yield* execution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))[0]!.inboxId,
            null,
            "opening the execution does not hand the task over; its handover does",
          )
          yield* db.linkTask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          const [task] = yield* sql<{
            id: number
          }>`SELECT id FROM inbox WHERE session_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`
          const [opened] = yield* execution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          assert.strictEqual(opened!.inboxId, task!.id)
          assert.strictEqual(opened!.input, "do it")
          yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { executionState: "completed" })
          yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
            executionState: "open",
            executionPromptedAt: 9,
          })
          const [again] = yield* execution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          assert.isNull(again!.inboxId)
          assert.strictEqual(again!.input, "")

          yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"))
          const sent = yield* db.insertSend("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "ping")
          yield* db.updateSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
            executionState: "open",
            executionPromptedAt: 3,
          })
          yield* db.setInboxStatus("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", [sent!.id], "delivered")
          const [sendExecution] = yield* execution("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
          assert.strictEqual(sendExecution!.inboxId, sent!.id)
          assert.strictEqual(sendExecution!.input, "ping")

          yield* db.insertSession(session("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), yield* projectOf("r"))
          const first = yield* db.insertSend("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "add a test")
          const second = yield* db.insertSend("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "also update the readme")
          yield* db.updateSession("cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
            executionState: "open",
            executionPromptedAt: 4,
          })
          yield* db.setInboxStatus("cccccccc-cccc-4ccc-8ccc-cccccccccccc", [first!.id, second!.id], "delivered")
          const [merged] = yield* execution("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
          assert.strictEqual(merged!.inboxId, second!.id)
          assert.strictEqual(merged!.input, "add a test\n\nalso update the readme")
          yield* db.updateSession("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { executionState: "completed" })
          const third = yield* db.insertSend("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "and the docs")
          yield* db.updateSession("cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
            executionState: "open",
            executionPromptedAt: 6,
          })
          yield* db.setInboxStatus("cccccccc-cccc-4ccc-8ccc-cccccccccccc", [third!.id], "delivered")
          const [next] = yield* execution("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
          assert.strictEqual(next!.inboxId, third!.id)
          assert.strictEqual(next!.input, "and the docs")
        }),
      ),
  )

  it.effect("startObserved keeps an execution that is already open and does not record the typed text", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"))
        yield* db.startObserved("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "kept", 1)
        yield* db.startObserved("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "dropped", 2)
        assert.deepStrictEqual(
          yield* sql<{
            input: string
          }>`SELECT input FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`,
          [{ input: "kept" }],
        )
      }),
    ),
  )

  it.effect("an observed end that needs the integration's ready report waits for the process to report ready", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Db
        const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        yield* db.insertSession(session(id), yield* projectOf("r"))
        yield* db.startObserved(id, "typed", 1)
        const end = {
          harness: "pi",
          at: 2,
          status: "completed" as const,
          reply: "done",
          failure: undefined,
          limited: false,
          conversation: undefined,
        }
        assert.isUndefined(yield* db.endObserved(id, { ...end, needsReady: true }))
        assert.strictEqual(yield* db.endObserved(id, { ...end, needsReady: false }), "completed")
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
    "the task is the first inbox row; the open execution is the message row with no ended_at; status is memory only",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
          cwd: "/w",
          task: "do it",
        })
        assert.deepStrictEqual(
          yield* sql`SELECT kind, content, status FROM inbox WHERE session_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`,
          [{ kind: "task", content: "do it", status: "delivered" }],
        )
        assert.deepStrictEqual(yield* db.pendingInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), [])
        assert.strictEqual((yield* db.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!.executionState, "none")
        assert.isFalse(yield* db.executionTaken("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "no open execution")
        yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
          status: "working",
          executionState: "open",
          executionPromptedAt: 5,
        })
        assert.isFalse(yield* db.executionTaken("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "task not handed over yet")
        assert.strictEqual(yield* db.untakenTask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "do it")
        yield* db.linkTask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        assert.isUndefined(yield* db.untakenTask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
        assert.isFalse(
          yield* db.executionTaken("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          "a task linked to the open execution is not yet proof the harness took it up",
        )
        const open = (yield* db.openExecution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!
        yield* db.acceptExecution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", open)
        assert.isTrue(
          yield* db.executionTaken("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          "its acceptance is the stored proof it was taken up",
        )
        assert.strictEqual(
          (yield* sql<{
            status: string
          }>`SELECT status FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`)[0]
            ?.status,
          "working",
        )
        assert.deepInclude(yield* db.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), {
          status: "working",
          executionState: "open",
          executionPromptedAt: 5,
        })
        yield* db.endExecution(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          { outcome: "completed", failure: { message: "late" } },
          { executionState: "completed" },
          undefined,
        )
        assert.strictEqual((yield* db.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!.executionState, "completed")
        const ended = (yield* db.latestReply("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!.execution
        assert.isFalse(yield* db.closeExecution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ended, "interrupted"))
        assert.strictEqual((yield* db.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!.executionState, "completed")
        assert.notProperty(
          (yield* sql`SELECT * FROM session WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`)[0],
          "status",
        )
      }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:")), Layer.provide(Bus.layer)))),
  )

  it.effect(
    "a execution-error notice goes to the parent while it has not ended, then to the project's current main session",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"))
        yield* db.insertSession(session("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), yield* projectOf("r"))
        yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
          parentSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        })
        yield* fact("project.entry_changed", {
          projectId: yield* projectOf("r"),
          data: { session: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
        })
        const recipientOf = (summary: string) =>
          Effect.map(
            sql<{
              recipient: string
            }>`SELECT session_id AS recipient FROM inbox WHERE kind = 'notice' AND instr(content, ${summary}) > 0`,
            (rows) => rows.map((row) => row.recipient),
          )
        const execution = (summary: string) =>
          Effect.gen(function* () {
            yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
              executionState: "open",
              executionPromptedAt: 1,
            })
            yield* db.endExecution(
              "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              { outcome: "failed", failure: { message: summary } },
              { executionState: "failed" },
              summary,
            )
          })
        yield* execution("one")
        assert.deepStrictEqual(yield* recipientOf("one"), ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])
        yield* db.updateSession("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { metadata: { archived: true, removed: true } })
        yield* execution("two")
        assert.deepStrictEqual(yield* recipientOf("two"), ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"])
      }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:")), Layer.provide(Bus.layer)))),
  )

  it.effect("a peer item received again after the project's entry changed is a duplicate, not a second notice", () =>
    Effect.gen(function* () {
      const db = yield* Db
      const sql = yield* SqlClient.SqlClient
      const project = yield* projectOf("r")
      const ended = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      yield* db.insertSession(session(ended), project)
      yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), project)
      yield* db.insertSession(session("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), project)
      yield* db.updateSession(ended, { metadata: { archived: true, removed: true } })
      const item = { id: "7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f", recipient: ended, content: "done on mb" }
      yield* fact("project.entry_changed", {
        projectId: project,
        data: { session: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      })
      assert.strictEqual(yield* db.receivePeerItem(item), "queued")
      yield* fact("project.entry_changed", {
        projectId: project,
        data: { session: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      })
      assert.strictEqual(yield* db.receivePeerItem(item), "duplicate")
      assert.deepStrictEqual(
        yield* sql<{
          recipient: string
        }>`SELECT session_id AS recipient FROM inbox WHERE peer_item = ${item.id}`,
        [{ recipient: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
      )
    }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:")), Layer.provide(Bus.layer)))),
  )

  it.effect("sessionBriefs: the task is the session's task row; latest is its newest execution", () =>
    Effect.gen(function* () {
      const db = yield* Db
      const execution = (id: string, at: number, end?: { at: number; outcome: string; reply?: string }) =>
        Effect.gen(function* () {
          const start = yield* fact("execution.started", { sessionId: id, at, data: {} })
          if (end === undefined) return
          yield* fact("execution.ended", {
            sessionId: id,
            at: end.at,
            data: { execution: start, outcome: end.outcome, ...(end.reply === undefined ? {} : { reply: end.reply }) },
          })
        })
      yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"))
      yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
        cwd: "/w",
        task: "from parent",
        parentSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      })
      yield* db.insertSend("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "later send")
      yield* execution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1, {
        at: 10,
        outcome: "completed",
        reply: "old summary",
      })
      yield* execution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 2, {
        at: 20,
        outcome: "failed",
        reply: "new line\nmore",
      })
      yield* db.insertSession(session("dddddddd-dddd-4ddd-8ddd-dddddddddddd"), yield* projectOf("r"), {
        cwd: "/w",
        task: "do it",
      })
      yield* db.insertSession(session("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"), yield* projectOf("r"))
      yield* db.updateSession("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", {
        executionState: "open",
        executionPromptedAt: 5,
      })
      yield* db.insertSession(session("ffffffff-ffff-4fff-8fff-ffffffffffff"), yield* projectOf("r"))
      yield* execution("ffffffff-ffff-4fff-8fff-ffffffffffff", 3, {
        at: 7,
        outcome: "interrupted",
        reply: "fallback\nrest",
      })
      yield* db.insertSession(session("11111111-1111-4111-8111-111111111111"), yield* projectOf("r"))
      yield* execution("11111111-1111-4111-8111-111111111111", 4, { at: 8, outcome: "lost", reply: "hidden" })

      const briefs = yield* db.sessionBriefs([
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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
        latest: { status: "lost", summary: "hidden", endedAt: 8 },
      })
      assert.isUndefined(briefs.get("00000000-0000-4000-8000-000000000000"))
      assert.strictEqual((yield* db.sessionBriefs([])).size, 0)
    }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:")), Layer.provide(Bus.layer)))),
  )
  it.effect("a notice with no coordinator is dropped; a claim takes a pending row once", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        const noticeStatus = (content: string) =>
          Effect.map(
            sql<{ status: string }>`SELECT status FROM inbox
              WHERE sender_session_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND kind = 'notice' AND content = ${content}`,
            (rows) => rows.map((row) => row.status).join(),
          )
        yield* db.insertSession(
          session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { executionState: "open" }),
          yield* projectOf("r"),
        )
        yield* db.endExecution(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          { outcome: "failed", failure: { message: "m" } },
          { executionState: "failed", status: "idle" },
          "m",
        )
        assert.strictEqual(yield* noticeStatus("m"), "dropped")
        yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, place)
        const row = yield* db.insertInbox({
          sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          message: "hi",
        })
        assert.strictEqual(row.status, "pending")
        const guard = {
          projectId: (yield* db.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!.projectId,
          runtime: RUNTIME,
          address: encodeAddress(place.address),
        }
        assert.deepStrictEqual(yield* db.claim(row.recipient!, [row.id], guard), [row.id])
        assert.deepStrictEqual(yield* db.claim(row.recipient!, [row.id], guard), [])
        yield* db.setInboxStatus(row.recipient!, [row.id], "delivered", "sending")
        assert.strictEqual(yield* noticeStatus("hi"), "delivered")
        yield* db.insertInbox({
          sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          message: "n",
        })
        yield* db.clearCoordinator(RUNTIME, place.address)
        assert.strictEqual(yield* noticeStatus("n"), "dropped")
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
        assert.deepStrictEqual(
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return (yield* sql<{ id: string }>`SELECT id FROM migration ORDER BY id`).map((row) => row.id)
          }).pipe(Effect.provide(Platform.sqlite(file))),
          migrations.map((migration) => migration.id),
        )
      }
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a database with another read-model version is rebuilt at open and keeps its migration rows; it opens again",
    () =>
      Effect.gen(function* () {
        const file = yield* fileAt(yield* tempDirectory("vibest-projection-"), "vibest.db")
        const sessions = Effect.flatMap(Db, (db) => db.listSessions({ stopped: true })).pipe(
          Effect.map((rows) => rows.map((row) => row.id)),
          Effect.provide(database(file)),
        )
        yield* Effect.gen(function* () {
          const db = yield* Db
          yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"))
        }).pipe(Effect.provide(database(file)))
        yield* writeSql(file, [
          "INSERT INTO migration (id, time_completed) VALUES ('20270101000000_kept', 1)",
          "UPDATE meta SET value = '0' WHERE key = 'projection'",
        ])
        assert.deepStrictEqual(yield* sessions, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])
        assert.deepStrictEqual(yield* sessions, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])
        const kept = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return {
            ids: (yield* sql<{ id: string }>`SELECT id FROM migration`).map((row) => row.id),
            projection: (yield* sql<{ value: string }>`SELECT value FROM meta WHERE key = 'projection'`)[0]?.value,
          }
        }).pipe(Effect.provide(Platform.sqlite(file)))
        assert.deepStrictEqual(kept, { ids: ["20270101000000_kept"], projection: String(PROJECTION_VERSION) })
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("pending migrations run in order at open, each once and recorded; a failing one changes nothing", () =>
    Effect.gen(function* () {
      const file = yield* fileAt(yield* tempDirectory("vibest-migrations-"), "vibest.db")
      yield* Effect.void.pipe(Effect.provide(database(file)))
      const ran: Array<string> = []
      const creating = (id: string, table: string, fails = false): Migration => ({
        id,
        up: (tx) =>
          tx.unsafe(`CREATE TABLE ${table} (x INTEGER) STRICT`).pipe(
            Effect.tap(() => Effect.sync(() => ran.push(id))),
            Effect.andThen(fails ? Effect.die("injected migration failure") : Effect.void),
          ),
      })
      const state = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return {
          ids: (yield* sql<{ id: string }>`SELECT id FROM migration ORDER BY id`).map((row) => row.id),
          tables: (yield* sql<{
            name: string
          }>`SELECT name FROM sqlite_schema WHERE name LIKE 'later_%' ORDER BY name`).map((row) => row.name),
        }
      })
      const steps = [creating("20270101000000_a", "later_a"), creating("20270102000000_b", "later_b")]
      yield* applyOnly(steps).pipe(Effect.provide(Platform.sqlite(file)))
      yield* applyOnly(steps).pipe(Effect.provide(Platform.sqlite(file)))
      assert.deepStrictEqual(ran, ["20270101000000_a", "20270102000000_b"])
      const failing = applyOnly([...steps, creating("20270103000000_c", "later_c", true)])
      assert.isTrue(Exit.isFailure(yield* Effect.exit(failing.pipe(Effect.provide(Platform.sqlite(file))))))
      assert.deepStrictEqual(yield* state.pipe(Effect.provide(Platform.sqlite(file))), {
        ids: ["20270101000000_a", "20270102000000_b"],
        tables: ["later_a", "later_b"],
      })
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("an incomplete file is rejected and left byte-identical", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDirectory("vibest-schema-partial-")
      const dropped = yield* fileAt(dir, "missing-table.db")
      yield* Effect.void.pipe(Effect.provide(database(dropped)))
      yield* writeSql(dropped, ["DROP INDEX project_repository_project", "DROP TABLE project_repository"])
      const droppedBytes = yield* fs.readFile(dropped)
      assert.include(yield* refusal(dropped), "missing project_repository")
      assert.deepStrictEqual(yield* fs.readFile(dropped), droppedBytes)
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a file of the shape before the event table (version 1 too, no event table) is refused, naming its path and how to move it aside",
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
        const before = yield* fs.readFile(file)
        const pretty = yield* refusal(file)
        assert.include(pretty, `${file} is from an older vibest`)
        assert.include(pretty, "the sessions, results and queued messages it holds are lost")
        assert.notInclude(pretty, "migration script")
        assert.deepStrictEqual(yield* fs.readFile(file), before)
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "import-check replays the log: it passes on a ledger, names the first row a changed read model differs in, and only replays an older read model",
    () =>
      Effect.gen(function* () {
        const file = yield* fileAt(yield* tempDirectory("vibest-import-check-"), "vibest.db")
        yield* Effect.gen(function* () {
          const db = yield* Db
          yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"))
        }).pipe(Effect.provide(database(file)))
        yield* Platform.daemon.checkDatabase(file)
        yield* writeSql(file, ["UPDATE session SET name = 'changed'"])
        const differs = yield* Effect.flip(Platform.daemon.checkDatabase(file))
        assert.strictEqual(differs._tag, "ReplayDiffers")
        assert.match(differs.message, /^the read model differs from a replay of its log: session row 1/)
        yield* writeSql(file, ["UPDATE meta SET value = '0' WHERE key = 'projection'"])
        yield* Platform.daemon.checkDatabase(file)
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a foreign database with user_version 1, or ours written by a newer event catalog, is refused without changing its bytes",
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
        yield* writeSql(newer, [`UPDATE meta SET value = '${CATALOG_VERSION + 1}' WHERE key = 'catalog'`])
        const newerBytes = yield* fs.readFile(newer)
        const newerSaid = yield* refusal(newer)
        assert.match(newerSaid, /SchemaMismatch/)
        assert.include(
          newerSaid,
          `${newer} was written by a newer vibest (event catalog ${CATALOG_VERSION + 1}, this vibest knows ${CATALOG_VERSION}): run vibest update`,
        )
        assert.deepStrictEqual(yield* fs.readFile(newer), newerBytes)
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("vibestd and import-check refuse a database in the old event shape and point to the CHANGELOG", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const file = yield* fileAt(yield* tempDirectory("vibest-schema-old-shape-"), "vibest.db")
      yield* writeSql(file, [
        `PRAGMA application_id = ${0x76696265}`,
        "CREATE TABLE event (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, project_id TEXT, session_id TEXT, data TEXT NOT NULL) STRICT",
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
        "CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL) STRICT",
        "INSERT INTO meta VALUES ('catalog', '1'), ('projection', '4')",
      ])
      const before = yield* fs.readFile(file)
      const said = `${file} is from an older vibest (its event log is the shape from before per-aggregate events): see "The event log is per aggregate" in the vibest CHANGELOG.`
      assert.include(yield* refusal(file), said)
      const checked = (yield* Effect.flip(Platform.daemon.checkDatabase(file))).message
      assert.include(checked, said)
      assert.notInclude(checked, "tools/")
      assert.deepStrictEqual(yield* fs.readFile(file), before)
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

  it.effect("sessionAt finds the one live session at that runtime and terminal", () =>
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

  it.effect(
    "a subagent resumes only after its execution ends; the main agent resumes a conversation the harness reported",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Db
          const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          yield* db.insertSession(session(id, { harnessId: "claude", harnessSessionId: "pre" }), yield* projectOf("r"))
          assert.isFalse(yield* db.canResumeConversation(id, "pre"))
          yield* db.updateSession(id, { executionState: "open", executionPromptedAt: 1 })
          yield* db.updateSession(id, { executionState: "completed" })
          assert.isTrue(yield* db.canResumeConversation(id, "pre"))
          const main = yield* db.coordinatorLaunch(yield* projectOf("r"), "claude", false, place)
          assert.isFalse(yield* db.canResumeConversation(main.sessionId, "c1"))
          yield* db.reportCoordinatorSession(main.sessionId, "claude", "c1")
          assert.isTrue(yield* db.canResumeConversation(main.sessionId, "c1"))
          assert.strictEqual(
            (yield* db.coordinatorLaunch(yield* projectOf("r"), "claude", false, place)).harnessSessionId,
            "c1",
          )
        }),
      ),
  )
})
