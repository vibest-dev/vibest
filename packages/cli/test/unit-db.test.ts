import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { executionStateOf } from "@vibest/core/database/db-rows"
import * as Projectors from "@vibest/core/database/projectors"
import { noticeEnvelope } from "@vibest/core/replies"
import { SessionLive } from "@vibest/core/session/live"
import { EXECUTIONS, projectOf } from "@vibest/platform-bun/test/lib/fakes"
import { session, place } from "@vibest/platform-bun/test/lib/unit-helpers"
import { Catalog, type FactType } from "@vibest/schema/event"
import { Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

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

const complete = (db: Db.Interface, id: string) =>
  Effect.gen(function* () {
    const open = yield* db.session.openExecution(id)

    if (open !== undefined) yield* db.session.closeExecution(id, open, "completed")
  })

describe("Db", () => {
  it.effect(
    "one entry session per project; fresh starts a new one and ends the old one; a harness switch clears the conversation; a conversation report names an existing session",
    () =>
      Effect.gen(function* () {
        const db = yield* Db.Service
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

  const memory = <A, E>(program: Effect.Effect<A, E, Bus.Service | Db.Service | SqlClient.SqlClient>) =>
    program.pipe(Effect.provide(memoryDb()))

  it.effect(
    "rescheduleSource: the open execution's input, the trailing delivered user or parent run, and the parent id; an empty open execution resends the trailing same-sender batch, not an earlier execution",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Db.Service
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
                ...(senderId !== null && { sender: senderId }),
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
                ...(senderId !== null && { sender: senderId }),
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
          const db = yield* Db.Service
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
        const db = yield* Db.Service
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

  it.effect(
    "an observed end that needs the ready report waits for it unless its reporter names the current process",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Db.Service
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
          const current = (yield* db.session.getSession(id))!.process!.id
          assert.strictEqual(yield* db.session.endObserved(id, { ...end, needsReady: true }, current), "completed")
        }),
      ),
  )

  it.effect("a rolled back endObserved leaves the live status working", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Db.Service
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
        const db = yield* Db.Service
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
        const db = yield* Db.Service
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
        const db = yield* Db.Service
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
        const db = yield* Db.Service
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
      const db = yield* Db.Service

      const execution = (id: string, at: number, end?: { at: number; outcome: string; reply?: string }) =>
        Effect.gen(function* () {
          const start = yield* fact("execution.started", { sessionId: id, at, data: {} })

          if (end === undefined) return
          yield* fact("execution.ended", {
            sessionId: id,
            at: end.at,
            data: { execution: start, outcome: end.outcome, ...(end.reply !== undefined && { reply: end.reply }) },
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
          const db = yield* Db.Service
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
          yield* db.inbox.dropWaiting(yield* projectOf("r"))
          assert.strictEqual(yield* noticeStatus("n"), "dropped")
        }),
      ),
  )

  it.effect("endProcess naming a process that is no longer the session's current one ends nothing", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Db.Service
        const project = yield* projectOf("r")
        const first = yield* db.session.startEntry(project, "claude", false, place, ENTRY)
        const old = (yield* db.session.getSession(first.sessionId))!.process!.id
        yield* db.session.startEntry(project, "claude", false, place, ENTRY)
        assert.isFalse(yield* db.session.endProcess(first.sessionId, "exited", old))
        assert.isNull((yield* db.session.getSession(first.sessionId))!.process!.endedAt)
      }),
    ),
  )

  it.effect(
    "a subagent resumes only after its execution ends; the entry session resumes a conversation the harness reported",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Db.Service
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

  it.effect("moving a project whose path has a non-BMP character carries its child session directories along", () =>
    Effect.gen(function* () {
      const db = yield* Db.Service
      const from = "/tmp/😀repo"
      const project = yield* projectOf(from)
      yield* db.session.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), project, { cwd: `${from}/sub` })
      yield* db.project.moveProject(project, "/tmp/moved", [])
      assert.strictEqual(yield* db.session.sessionDirectory("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "/tmp/moved/sub")
    }).pipe(Effect.provide(memoryDb())),
  )
})
