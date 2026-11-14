import { Database } from "bun:sqlite"
import url from "node:url"

import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { executionStateOf } from "@vibest/core/database/db-rows"
import { APPLICATION_ID, PROJECTION_VERSION } from "@vibest/core/database/db-schema"
import { applyOnly, type Migration, migrations } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { noticeEnvelope } from "@vibest/core/replies"
import { SessionLive } from "@vibest/core/session/live"
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
    const bus = yield* Bus.Service
    return yield* bus.publish(Catalog[type] as never, input as never)
  }).pipe(Effect.orDie)

const memoryDb = () =>
  Db.layer.pipe(
    Layer.provide(Projectors.layer),
    Layer.provideMerge(Bus.layer),
    Layer.provide(SessionLive.layer),
    Layer.provideMerge(Platform.sqlite(":memory:")),
  )

const ENTRY = { agent: "coordinator" } as const

const complete = (db: Db["Service"], id: string) =>
  Effect.gen(function* () {
    const open = yield* db.session.openExecution(id)
    if (open !== undefined) yield* db.session.closeExecution(id, open, "completed")
  })

describe("Db", () => {
  it.effect(
    "one entry session per project; fresh starts a new one and ends the old one; a harness switch clears the conversation; a conversation report names an existing session",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const first = yield* db.session.startEntry(yield* projectOf("r"), "pi", false, place, ENTRY)
        assert.isNull(first.harnessSessionId)
        yield* db.session.noteConversation(first.sessionId, "s1")
        const again = yield* db.session.startEntry(yield* projectOf("r"), "pi", false, place, ENTRY)
        assert.strictEqual(again.sessionId, first.sessionId)
        assert.strictEqual(again.harnessSessionId, "s1")
        yield* db.session.noteConversation("0e0e0000-0e0e-40e0-80e0-0e0e00000e0e", "x")
        assert.strictEqual(
          (yield* db.session.startEntry(yield* projectOf("r"), "pi", false, place, ENTRY)).harnessSessionId,
          "s1",
        )
        const renewed = yield* db.session.startEntry(yield* projectOf("r"), "pi", true, place, ENTRY)
        assert.notStrictEqual(renewed.sessionId, first.sessionId)
        assert.isNull(renewed.harnessSessionId)
        yield* db.session.noteConversation(renewed.sessionId, "s4")
        assert.isNull(
          (yield* db.session.startEntry(yield* projectOf("r"), "claude", false, place, ENTRY)).harnessSessionId,
        )
        yield* db.session.noteConversation(renewed.sessionId, "c1")
        assert.strictEqual(
          (yield* db.session.startEntry(yield* projectOf("r"), "pi", false, place, ENTRY)).sessionId,
          renewed.sessionId,
        )
        assert.isNull((yield* db.session.startEntry(yield* projectOf("r"), "pi", false, place, ENTRY)).harnessSessionId)
        yield* db.session.noteConversation(renewed.sessionId, "s6")
        yield* db.session.noteConversation(renewed.sessionId, "s7")
        assert.strictEqual(
          (yield* db.session.startEntry(yield* projectOf("r"), "pi", false, place, ENTRY)).harnessSessionId,
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
          entryId: string
        }>`SELECT entry_session_id AS entryId FROM project WHERE id = ${yield* projectOf("r")}`
        assert.strictEqual(project!.entryId, renewed.sessionId)
      }).pipe(Effect.provide(memoryDb())),
  )

  const memory = <A, E>(program: Effect.Effect<A, E, Bus.Service | Db | SqlClient.SqlClient>) =>
    program.pipe(Effect.provide(memoryDb()))

  it.effect(
    "rescheduleSource: the open execution's input, the trailing delivered user or parent run, and the parent id; an empty open execution resends the trailing same-sender batch, not an earlier execution",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Db
          const parent = yield* db.session.startEntry(yield* projectOf("r"), "pi", false, place, ENTRY)
          yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
            cwd: "/w",
            task: "do it",
            parentSessionId: parent.sessionId,
          })
          yield* db.session.startObserved("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "typed", 1)
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
          assert.deepStrictEqual(yield* db.session.rescheduleSource("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), {
            working: "typed",
            delivered: "a notice",
            parentSessionId: parent.sessionId,
            since: 1,
          })
          yield* complete(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          yield* db.session.startExecution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 2)
          assert.strictEqual((yield* db.session.rescheduleSource("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).working, "")
          yield* complete(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          assert.deepStrictEqual(yield* db.session.rescheduleSource("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), {
            working: "",
            delivered: "a notice",
            parentSessionId: parent.sessionId,
            since: 2,
          })
          assert.deepStrictEqual(yield* db.session.rescheduleSource("00000000-0000-4000-8000-000000000000"), {
            working: "",
            delivered: "",
            parentSessionId: undefined,
            since: 0,
          })

          yield* db.session.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"), {
            cwd: "/w",
            task: "do it",
            parentSessionId: parent.sessionId,
          })
          yield* db.session.startExecution("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 1)
          yield* complete(db, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
          yield* db.session.startExecution("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 3)
          const follow = yield* db.inbox.insertSend("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "add tests")
          yield* db.inbox.setInboxStatus("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", [follow!.id], "delivered")
          yield* complete(db, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
          yield* db.session.startExecution("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 5)
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
          assert.strictEqual(
            (yield* db.session.rescheduleSource("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).delivered,
            "and docs",
          )
          yield* row("send", null, "also types")
          assert.deepStrictEqual(yield* db.session.rescheduleSource("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), {
            working: "",
            delivered: "and docs\n\nalso types",
            parentSessionId: parent.sessionId,
            since: 5,
          })
          yield* row("send", null, "still pending", "pending")
          yield* row("notice", parent.sessionId, "a notice", "pending")
          assert.strictEqual(
            (yield* db.session.rescheduleSource("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).delivered,
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
          yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
            cwd: "/w",
            task: "do it",
          })
          yield* db.session.startExecution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 5)
          assert.strictEqual(
            (yield* execution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))[0]!.inboxId,
            null,
            "opening the execution does not hand the task over; its handover does",
          )
          yield* db.inbox.linkTask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          const [task] = yield* sql<{
            id: number
          }>`SELECT id FROM inbox WHERE session_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`
          const [opened] = yield* execution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          assert.strictEqual(opened!.inboxId, task!.id)
          assert.strictEqual(opened!.input, "do it")
          yield* complete(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          yield* db.session.startExecution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 9)
          const [again] = yield* execution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          assert.isNull(again!.inboxId)
          assert.strictEqual(again!.input, "")

          yield* db.session.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"))
          const sent = yield* db.inbox.insertSend("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "ping")
          yield* db.session.startExecution("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 3)
          yield* db.inbox.setInboxStatus("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", [sent!.id], "delivered")
          const [sendExecution] = yield* execution("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
          assert.strictEqual(sendExecution!.inboxId, sent!.id)
          assert.strictEqual(sendExecution!.input, "ping")

          yield* db.session.insertSession(session("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), yield* projectOf("r"))
          const first = yield* db.inbox.insertSend("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "add a test")
          const second = yield* db.inbox.insertSend("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "also update the readme")
          yield* db.session.startExecution("cccccccc-cccc-4ccc-8ccc-cccccccccccc", 4)
          yield* db.inbox.setInboxStatus("cccccccc-cccc-4ccc-8ccc-cccccccccccc", [first!.id, second!.id], "delivered")
          const [merged] = yield* execution("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
          assert.strictEqual(merged!.inboxId, second!.id)
          assert.strictEqual(merged!.input, "add a test\n\nalso update the readme")
          yield* complete(db, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")
          const third = yield* db.inbox.insertSend("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "and the docs")
          yield* db.session.startExecution("cccccccc-cccc-4ccc-8ccc-cccccccccccc", 6)
          yield* db.inbox.setInboxStatus("cccccccc-cccc-4ccc-8ccc-cccccccccccc", [third!.id], "delivered")
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
        yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"))
        yield* db.session.startObserved("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "kept", 1)
        yield* db.session.startObserved("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "dropped", 2)
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
        yield* db.session.insertSession(session(id), yield* projectOf("r"))
        yield* db.session.startObserved(id, "typed", 1)
        const end = {
          harness: "pi",
          at: 2,
          status: "completed" as const,
          reply: "done",
          failure: undefined,
          limited: false,
          conversation: undefined,
        }
        assert.isUndefined(yield* db.session.endObserved(id, { ...end, needsReady: true }))
        assert.strictEqual(yield* db.session.endObserved(id, { ...end, needsReady: false }), "completed")
      }),
    ),
  )

  it.effect("a rolled back endObserved leaves the live status working", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        const parent = yield* db.session.startEntry(yield* projectOf("r"), "pi", false, place, ENTRY)
        yield* db.session.insertSession(session(id), yield* projectOf("r"), {
          cwd: "/w",
          parentSessionId: parent.sessionId,
        })
        yield* db.session.startObserved(id, "typed", 1)
        assert.strictEqual((yield* db.session.getSession(id))?.status, "working")
        yield* sql`CREATE TRIGGER no_notice BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'no notice'); END`
        const end = {
          harness: "pi",
          at: 2,
          status: "failed" as const,
          reply: "",
          failure: "boom",
          limited: false,
          conversation: undefined,
          needsReady: false,
        }
        assert.isTrue(Exit.isFailure(yield* Effect.exit(db.session.endObserved(id, end))))
        assert.strictEqual((yield* db.session.getSession(id))?.status, "working")
      }),
    ),
  )

  it.effect("a rolled back patchLive ready leaves the live integration unchanged", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        yield* db.session.insertSession(session(id), yield* projectOf("r"))
        yield* sql`CREATE TRIGGER no_ready BEFORE UPDATE OF ready_at ON process BEGIN SELECT RAISE(ABORT, 'no ready'); END`
        const exit = yield* Effect.exit(
          db.session.patchLive(id, { ready: 5, integration: { version: "9.9.9", protocol: 1 } }),
        )
        assert.isTrue(Exit.isFailure(exit))
        assert.isNull((yield* db.session.getSession(id))?.process?.integration)
      }),
    ),
  )

  it.effect(
    "the task is the first inbox row; the open execution is the message row with no ended_at; status is memory only",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
          cwd: "/w",
          task: "do it",
        })
        assert.deepStrictEqual(
          yield* sql`SELECT kind, content, status FROM inbox WHERE session_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`,
          [{ kind: "task", content: "do it", status: "delivered" }],
        )
        assert.deepStrictEqual(yield* db.inbox.pendingInbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), [])
        assert.strictEqual(
          executionStateOf((yield* db.session.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!),
          "none",
        )
        assert.isFalse(yield* db.session.executionTaken("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "no open execution")
        yield* db.session.startExecution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 5)
        yield* db.session.setStatus("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "working")
        assert.isFalse(
          yield* db.session.executionTaken("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          "task not handed over yet",
        )
        assert.strictEqual(yield* db.inbox.untakenTask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "do it")
        yield* db.inbox.linkTask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        assert.isUndefined(yield* db.inbox.untakenTask("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
        assert.isFalse(
          yield* db.session.executionTaken("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          "a task linked to the open execution is not yet proof the harness took it up",
        )
        const open = (yield* db.session.openExecution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!
        yield* db.session.acceptExecution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", open)
        assert.isTrue(
          yield* db.session.executionTaken("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          "its acceptance is the stored proof it was taken up",
        )
        assert.strictEqual(
          (yield* sql<{
            status: string
          }>`SELECT status FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`)[0]
            ?.status,
          "working",
        )
        const working = (yield* db.session.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!
        assert.strictEqual(working.status, "working")
        assert.strictEqual(executionStateOf(working), "open")
        assert.strictEqual(working.openExecution?.startedAt, 5)
        yield* db.session.endExecution(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          { outcome: "completed", failure: { message: "late" } },
          undefined,
        )
        assert.strictEqual(
          executionStateOf((yield* db.session.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!),
          "completed",
        )
        const ended = (yield* db.session.latestReply("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!.execution
        assert.isFalse(yield* db.session.closeExecution("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ended, "interrupted"))
        assert.strictEqual(
          executionStateOf((yield* db.session.getSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))!),
          "completed",
        )
        assert.notProperty(
          (yield* sql`SELECT * FROM session WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`)[0],
          "status",
        )
      }).pipe(Effect.provide(memoryDb())),
  )

  it.effect(
    "an execution-error notice goes to the nearest creator that has not ended; with none left it writes no row",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        const project = yield* projectOf("r")
        const [grand, parent, child] = [
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ] as const
        yield* db.session.insertSession(session(grand), project)
        yield* db.session.insertSession(session(parent), project, { parentSessionId: grand })
        yield* db.session.insertSession(session(child), project, { parentSessionId: parent })
        const recipientOf = (summary: string) =>
          Effect.map(
            sql<{
              recipient: string
            }>`SELECT session_id AS recipient FROM inbox WHERE kind = 'notice' AND instr(content, ${summary}) > 0`,
            (rows) => rows.map((row) => row.recipient),
          )
        const execution = (summary: string) =>
          Effect.gen(function* () {
            yield* db.session.startExecution(child, 1)
            yield* db.session.endExecution(child, { outcome: "failed", failure: { message: summary } }, summary)
          })
        yield* execution("one")
        assert.deepStrictEqual(yield* recipientOf("one"), [parent])
        yield* db.session.archive(parent)
        yield* execution("two")
        assert.deepStrictEqual(yield* recipientOf("two"), [grand])
        yield* db.session.archive(grand)
        yield* execution("three")
        assert.deepStrictEqual(yield* recipientOf("three"), [])
      }).pipe(Effect.provide(memoryDb())),
  )

  it.effect(
    "a peer item for an ended session goes to its nearest living creator, once; with none only a dropped row stays",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        const project = yield* projectOf("r")
        const ended = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        const creator = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        yield* db.session.insertSession(session(creator), project)
        yield* db.session.insertSession(session(ended), project, { parentSessionId: creator })
        yield* db.session.archive(ended)
        const item = (id: string) => ({
          id,
          recipient: ended,
          kind: "notice" as const,
          sender: "mb/aaaaaaaa",
          content: "done on mb",
        })
        const rows = () =>
          sql<{
            recipient: string
            status: string
          }>`SELECT session_id AS recipient, status FROM inbox WHERE kind = 'notice'`
        assert.strictEqual(yield* db.remote.receivePeerItem(item("7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f")), "queued")
        assert.strictEqual(yield* db.remote.receivePeerItem(item("7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f")), "duplicate")
        assert.deepStrictEqual(yield* rows(), [{ recipient: creator, status: "pending" }])
        yield* db.session.archive(creator)
        assert.strictEqual(yield* db.remote.receivePeerItem(item("8c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f")), "queued")
        assert.deepStrictEqual(yield* rows(), [
          { recipient: creator, status: "pending" },
          { recipient: ended, status: "dropped" },
        ])
      }).pipe(Effect.provide(memoryDb())),
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
      yield* db.session.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"))
      yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
        cwd: "/w",
        task: "from parent",
        parentSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      })
      yield* db.inbox.insertSend("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "later send")
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
      yield* db.session.insertSession(session("dddddddd-dddd-4ddd-8ddd-dddddddddddd"), yield* projectOf("r"), {
        cwd: "/w",
        task: "do it",
      })
      yield* db.session.insertSession(session("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"), yield* projectOf("r"))
      yield* db.session.startExecution("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", 5)
      yield* db.session.insertSession(session("ffffffff-ffff-4fff-8fff-ffffffffffff"), yield* projectOf("r"))
      yield* execution("ffffffff-ffff-4fff-8fff-ffffffffffff", 3, {
        at: 7,
        outcome: "interrupted",
        reply: "fallback\nrest",
      })
      yield* db.session.insertSession(session("11111111-1111-4111-8111-111111111111"), yield* projectOf("r"))
      yield* execution("11111111-1111-4111-8111-111111111111", 4, { at: 8, outcome: "lost", reply: "hidden" })

      const briefs = yield* db.session.sessionBriefs([
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
      assert.strictEqual((yield* db.session.sessionBriefs([])).size, 0)
    }).pipe(Effect.provide(memoryDb())),
  )
  it.effect(
    "a notice for a session nobody started writes no row; one for a session its entry started is pending, claimed once, and dropped once the entry has no process",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Db
          const sql = yield* SqlClient.SqlClient
          const noticeStatus = (content: string) =>
            Effect.map(
              sql<{ status: string }>`SELECT status FROM inbox
              WHERE sender_session_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND kind = 'notice' AND content = ${noticeEnvelope(content)}`,
              (rows) => rows.map((row) => row.status).join(),
            )
          yield* db.session.insertSession(
            session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { executionState: "open" }),
            yield* projectOf("r"),
          )
          assert.isUndefined(
            yield* db.inbox.insertInbox({ sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", message: "m" }),
          )
          const entry = yield* db.session.startEntry(yield* projectOf("r"), "pi", false, place, ENTRY)
          yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), {
            parentSessionId: entry.sessionId,
          })
          const row = yield* db.inbox.insertInbox({
            sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            message: "hi",
          })
          assert.strictEqual(row!.status, "pending")
          assert.deepStrictEqual(yield* db.inbox.claim(row!.recipient!, [row!.id]), [row!.id])
          assert.deepStrictEqual(yield* db.inbox.claim(row!.recipient!, [row!.id]), [])
          yield* db.inbox.setInboxStatus(row!.recipient!, [row!.id], "delivered", "delivering")
          assert.strictEqual(yield* noticeStatus("hi"), "delivered")
          yield* db.inbox.insertInbox({
            sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            message: "n",
          })
          yield* db.session.clearEntry(RUNTIME, place.address)
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
      Layer.provide(Projectors.layer),
      Layer.provide(Bus.layer),
      Layer.provide(SessionLive.layer),
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
          assert.isTrue(
            yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r")),
          )
          assert.match((yield* db.session.startEntry(yield* projectOf("r"), "pi", false, place, ENTRY)).sessionId, ID)
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
        const sessions = Effect.flatMap(Db, (db) => db.session.listSessions({ stopped: true })).pipe(
          Effect.map((rows) => rows.map((row) => row.id)),
          Effect.provide(database(file)),
        )
        yield* Effect.gen(function* () {
          const db = yield* Db
          yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"))
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
          yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"))
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

  it.effect("two empty opens both initialize", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDirectory("vibest-schema-race-")
      const file = yield* fileAt(dir, "vibest.db")
      const script = yield* fileAt(dir, "open.ts")
      const dbModule = url.fileURLToPath(new URL("../../../packages/core/src/database/db.ts", import.meta.url))
      const busModule = url.fileURLToPath(new URL("../../../packages/core/src/bus.ts", import.meta.url))
      const projectorsModule = url.fileURLToPath(
        new URL("../../../packages/core/src/database/projectors.ts", import.meta.url),
      )
      const liveModule = url.fileURLToPath(new URL("../../../packages/core/src/session/live.ts", import.meta.url))
      const platformModule = url.fileURLToPath(new URL("../../platform-bun/src/bun.ts", import.meta.url))
      yield* fs.writeFileString(
        script,
        [
          'import { Effect, Layer } from "effect"',
          `import { Bus } from ${JSON.stringify(busModule)}`,
          `import * as Projectors from ${JSON.stringify(projectorsModule)}`,
          `import { SessionLive } from ${JSON.stringify(liveModule)}`,
          `import { Db } from ${JSON.stringify(dbModule)}`,
          `import * as Platform from ${JSON.stringify(platformModule)}`,
          "await Effect.runPromise(Effect.void.pipe(Effect.provide(Db.layer.pipe(Layer.provide(Projectors.layer), Layer.provide(Bus.layer), Layer.provide(SessionLive.layer), Layer.provide(Platform.sqlite(process.argv[2]!))))))",
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
    "a subagent resumes only after its execution ends; the entry session resumes a conversation the harness reported",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Db
          const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          yield* db.session.insertSession(
            session(id, { harnessId: "claude", harnessSessionId: "pre" }),
            yield* projectOf("r"),
          )
          assert.isFalse(yield* db.session.canResumeConversation(id, "pre"))
          yield* db.session.startExecution(id, 1)
          yield* complete(db, id)
          assert.isTrue(yield* db.session.canResumeConversation(id, "pre"))
          const entry = yield* db.session.startEntry(yield* projectOf("r"), "claude", false, place, ENTRY)
          assert.isFalse(yield* db.session.canResumeConversation(entry.sessionId, "c1"))
          yield* db.session.noteConversation(entry.sessionId, "c1")
          assert.isTrue(yield* db.session.canResumeConversation(entry.sessionId, "c1"))
          assert.strictEqual(
            (yield* db.session.startEntry(yield* projectOf("r"), "claude", false, place, ENTRY)).harnessSessionId,
            "c1",
          )
        }),
      ),
  )
})
