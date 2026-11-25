import { assert, describe, it } from "@effect/vitest"
import { Bus, equalToReplay } from "@vibest/core/bus"
import { installBaseline } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { type DurableEvent, type DurableEventOf } from "@vibest/schema/durable-event-manifest"
import { MachineEvent } from "@vibest/schema/machine-event"
import { ProcessEvent } from "@vibest/schema/process-event"
import { ProjectEvent } from "@vibest/schema/project-event"
import { SessionEvent } from "@vibest/schema/session-event"
import { Effect, Exit, Fiber, Layer, PubSub, Stream } from "effect"
import { SqlClient } from "effect/sql"

import { memorySqlite } from "./platform/bun.ts"

const P = "11111111-1111-4111-8111-111111111111"
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222"
const MAIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SUB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const REMOTE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const PEER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const MACHINE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const ITEM = "7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f"
const ITEM_2 = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"

const memory = () => Layer.fresh(Projectors.replay.pipe(Layer.provideMerge(memorySqlite)))

const ledger = Effect.gen(function* () {
  yield* installBaseline
  const bus = yield* Bus.Service
  const subscription = yield* bus.subscribe()
  const published = PubSub.takeUpTo(subscription, Number.MAX_SAFE_INTEGER)
  const sql = yield* SqlClient.SqlClient

  return { bus, published, sql }
})

const replayDifference = (sql: SqlClient.SqlClient) => equalToReplay(sql).pipe(Effect.provide(memory()))

const eventCount = (sql: SqlClient.SqlClient) =>
  sql<{ n: number }>`SELECT count(*) AS n FROM event`.pipe(Effect.map((rows) => rows[0]!.n))

const story = Effect.gen(function* () {
  const { bus, sql } = yield* ledger
  const { publish: emit, transaction: commit } = bus

  const ids = yield* commit(
    Effect.gen(function* () {
      yield* emit(MachineEvent.Added, { name: "mb", target: "root@mb", remote: MACHINE }, { at: 100 })
      yield* emit(MachineEvent.Connected, { name: "mb" }, { at: 150 })
      yield* emit(MachineEvent.RemoteSeen, { remoteId: PEER, name: "mac" }, { at: 160 })
      yield* emit(MachineEvent.RemoteSeen, { remoteId: PEER, name: "mac2" }, { at: 170 })
      yield* emit(
        ProjectEvent.Created,
        { projectId: P, directory: "/w/app", repositories: [{ path: "/w/app", remote: "git@x:app.git" }] },
        { at: 200 },
      )
      yield* emit(
        SessionEvent.Created,
        { sessionId: MAIN, project: P, agent: "main", name: "main", directory: "" },
        { at: 210 },
      )
      yield* emit(SessionEvent.DirectoryChanged, { sessionId: MAIN, directory: "/w/app" }, { at: 212 })

      const mainProcess = 1
      yield* emit(
        ProcessEvent.Started,
        { sessionId: MAIN, processId: mainProcess, harness: "claude", runtime: "herdr" },
        { at: 220 },
      )
      yield* emit(
        ProcessEvent.Updated,
        { sessionId: MAIN, processId: mainProcess, terminal: { id: "w1:p1" }, pid: 10 },
        { at: 225 },
      )
      yield* emit(
        ProcessEvent.Ready,
        { sessionId: MAIN, processId: mainProcess, pid: 11, integration: { version: "0.0.1", protocol: 8 } },
        { at: 230 },
      )
      yield* emit(ProcessEvent.Ready, { sessionId: MAIN, processId: mainProcess }, { at: 235 })
      yield* emit(ProcessEvent.Updated, { sessionId: MAIN, processId: mainProcess, pid: 12 }, { at: 236 })
      yield* emit(
        ProcessEvent.Updated,
        { sessionId: MAIN, processId: mainProcess, conversation: "conv-main" },
        { at: 237 },
      )

      yield* emit(
        SessionEvent.Created,
        { sessionId: SUB, project: P, agent: "subagent", name: "tests", directory: "/w/app/wt", parent: MAIN },
        { at: 300 },
      )

      const task = 1
      yield* emit(
        SessionEvent.InboxEnqueued,
        {
          sessionId: SUB,
          messageId: task,
          sender: { type: "agent", session: MAIN },
          content: "fix it",
          requestId: "r-1",
        },
        { at: 301 },
      )

      const subProcess = 1
      yield* emit(
        ProcessEvent.Started,
        {
          sessionId: SUB,
          processId: subProcess,
          harness: "pi",
          provider: "cpa",
          model: "grok",
          routing: { decidedBy: { harness: "choice" }, trace: [] },
          runtime: "herdr",
          terminal: { id: "w1:p2" },
          pid: 20,
        },
        { at: 302 },
      )

      const execution = 1
      yield* emit(
        SessionEvent.ExecutionAllocated,
        { sessionId: SUB, executionId: execution, processId: subProcess },
        { at: 309 },
      )
      yield* emit(
        SessionEvent.ExecutionStarted,
        { sessionId: SUB, executionId: execution, processId: subProcess },
        { at: 310 },
      )
      yield* emit(
        SessionEvent.InboxDelivered,
        { sessionId: SUB, messageId: task, recipientExecutionId: execution },
        { at: 311 },
      )
      yield* emit(
        SessionEvent.ExecutionSucceeded,
        { sessionId: SUB, executionId: execution, reply: "All tests pass." },
        { at: 321 },
      )

      const result = 1
      yield* emit(
        SessionEvent.InboxEnqueued,
        {
          sessionId: MAIN,
          messageId: result,
          sender: { type: "vibest" },
          aboutSessionId: SUB,
          content: "",
        },
        { at: 322 },
      )
      yield* emit(SessionEvent.InboxDelivering, { sessionId: MAIN, messageId: result }, { at: 323 })
      yield* emit(ProcessEvent.Ended, { sessionId: SUB, processId: subProcess, reason: "restart" }, { at: 330 })

      const placeholder = 2
      yield* emit(
        ProcessEvent.Started,
        { sessionId: SUB, processId: placeholder, harness: "claude", runtime: "herdr" },
        { at: 331 },
      )
      yield* emit(ProcessEvent.Ended, { sessionId: SUB, processId: placeholder, reason: "launch_failed" }, { at: 332 })
      yield* emit(SessionEvent.Renamed, { sessionId: SUB, name: "fix-tests" }, { at: 333 })

      yield* emit(
        ProjectEvent.RepositoriesChanged,
        { projectId: P, repositories: [{ path: "/w/app/lib" }] },
        { at: 400 },
      )
      yield* emit(
        ProjectEvent.Moved,
        { projectId: P, from: "/w/app", to: "/src/app", repositories: [{ path: "/src/app", remote: "git@x:app.git" }] },
        { at: 410 },
      )

      yield* emit(
        SessionEvent.Created,
        {
          sessionId: REMOTE,
          project: P,
          agent: "subagent",
          name: "remote",
          directory: "/src/app",
          origin: { remote: PEER, project: OTHER_PROJECT, session: MAIN },
        },
        { at: 500 },
      )
      yield* emit(
        MachineEvent.OutboxQueued,
        { id: ITEM, remoteId: PEER, session: REMOTE, content: "done" },
        { at: 510 },
      )
      yield* emit(
        MachineEvent.OutboxQueued,
        { id: ITEM_2, remoteId: PEER, session: REMOTE, kind: "send", content: "archived" },
        { at: 511 },
      )
      yield* emit(MachineEvent.OutboxAcked, { remoteId: PEER, ids: [ITEM] }, { at: 520 })

      const notice = 2
      yield* emit(
        SessionEvent.InboxEnqueued,
        {
          sessionId: MAIN,
          messageId: notice,
          sender: { type: "vibest" },
          content: "remote done",
          transferId: ITEM,
        },
        { at: 530 },
      )

      const typed = 1
      yield* emit(
        SessionEvent.ExecutionAllocated,
        { sessionId: MAIN, executionId: typed, processId: mainProcess, typed: "hello" },
        { at: 539 },
      )
      yield* emit(
        SessionEvent.ExecutionStarted,
        { sessionId: MAIN, executionId: typed, processId: mainProcess },
        { at: 540 },
      )
      yield* emit(
        SessionEvent.ExecutionFailed,
        { sessionId: MAIN, executionId: typed, failure: { message: "model overloaded" } },
        { at: 541 },
      )
      yield* emit(MachineEvent.Removed, { name: "mb" }, { at: 600 })

      return { mainProcess, task, subProcess, execution, result, placeholder, notice, typed }
    }),
  )

  return { ...ids, sql, bus }
})

const rowsOf = <A extends object>(sql: SqlClient.SqlClient, query: string) => sql.unsafe<A>(query)

describe("projectors", () => {
  it.effect("project events: created, repositories, move", () =>
    Effect.gen(function* () {
      const { sql } = yield* story

      const [project] = yield* rowsOf<{ directory: string }>(sql, "SELECT directory FROM project")

      assert.strictEqual(project!.directory, "/src/app")
      assert.deepStrictEqual(
        yield* rowsOf(sql, "SELECT project_id, path, remote_url FROM project_repository ORDER BY path"),
        [{ projectId: P, path: "/src/app", remoteUrl: "git@x:app.git" }],
      )
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT id, directory FROM session ORDER BY id"), [
        { id: MAIN, directory: "/src/app" },
        { id: SUB, directory: "/src/app/wt" },
        { id: REMOTE, directory: "/src/app" },
      ])
    }).pipe(Effect.provide(memory())),
  )

  it.effect("repositories_changed leaves a path owned by another project alone", () =>
    Effect.gen(function* () {
      const { bus, sql } = yield* ledger
      yield* bus.transaction(
        Effect.gen(function* () {
          yield* bus.publish(ProjectEvent.Created, {
            projectId: P,
            directory: "/a",
            repositories: [{ path: "/a" }],
          })
          yield* bus.publish(ProjectEvent.Created, { projectId: OTHER_PROJECT, repositories: [] })
          yield* bus.publish(ProjectEvent.RepositoriesChanged, {
            projectId: OTHER_PROJECT,
            repositories: [{ path: "/a", remote: "r" }],
          })
          yield* bus.publish(ProjectEvent.RepositoriesChanged, {
            projectId: P,
            repositories: [{ path: "/a", remote: "mine" }],
          })
        }),
      )
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT project_id, path, remote_url FROM project_repository"), [
        { projectId: P, path: "/a", remoteUrl: "mine" },
      ])
    }).pipe(Effect.provide(memory())),
  )

  it.effect("session events: created, renamed, origin, ended and current process", () =>
    Effect.gen(function* () {
      const { sql, subProcess, mainProcess } = yield* story

      const rows = yield* rowsOf<Readonly<Record<string, string | number | null>>>(
        sql,
        `SELECT id, name, agent, parent_session_id, origin_remote,
          origin_project, origin_session, created_at, ended_at, process_id, active_at
        FROM session ORDER BY created_at`,
      )

      assert.deepStrictEqual(rows, [
        {
          id: MAIN,
          name: "main",
          agent: "main",
          parentSessionId: null,
          originRemote: null,
          originProject: null,
          originSession: null,
          createdAt: 210,
          endedAt: null,
          processId: mainProcess,
          activeAt: 541,
        },
        {
          id: SUB,
          name: "fix-tests",
          agent: "subagent",
          parentSessionId: MAIN,
          originRemote: null,
          originProject: null,
          originSession: null,
          createdAt: 300,
          endedAt: null,
          processId: subProcess,
          activeAt: 332,
        },
        {
          id: REMOTE,
          name: "remote",
          agent: "subagent",
          parentSessionId: null,
          originRemote: PEER,
          originProject: OTHER_PROJECT,
          originSession: MAIN,
          createdAt: 500,
          endedAt: null,
          processId: null,
          activeAt: 500,
        },
      ])
    }).pipe(Effect.provide(memory())),
  )

  it.effect("session.archived keeps the first end time and stops offering the session's outbox", () =>
    Effect.gen(function* () {
      const { sql, bus } = yield* story
      yield* bus.transaction(
        Effect.gen(function* () {
          yield* bus.publish(SessionEvent.Archived, { sessionId: REMOTE }, { at: 700 })
          yield* bus.publish(SessionEvent.Archived, { sessionId: REMOTE }, { at: 800 })
        }),
      )
      assert.deepStrictEqual(yield* rowsOf(sql, `SELECT ended_at FROM session WHERE id = '${REMOTE}'`), [
        { endedAt: 700 },
      ])
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT id FROM outbox WHERE acked_at IS NULL"), [{ id: ITEM_2 }])
      assert.deepStrictEqual(
        yield* rowsOf(
          sql,
          `SELECT o.id FROM outbox o JOIN session s ON s.id = o.session_id
            WHERE o.acked_at IS NULL AND s.ended_at IS NULL`,
        ),
        [],
      )
    }).pipe(Effect.provide(memory())),
  )

  it.effect("process events: placed, ready, pid, conversation, ended", () =>
    Effect.gen(function* () {
      const { sql, mainProcess, subProcess } = yield* story

      const rows = yield* rowsOf<Readonly<Record<string, string | number | null>>>(
        sql,
        `SELECT id, harness, provider, model, routing, runtime, terminal, pid, integration_version,
          integration_protocol, harness_session_id, started_at, placed_at, ready_at, ended_at, end_reason
        FROM process ORDER BY started_at`,
      )

      assert.deepStrictEqual(rows[0], {
        id: mainProcess,
        harness: "claude",
        provider: null,
        model: null,
        routing: null,
        runtime: "herdr",
        terminal: JSON.stringify({ id: "w1:p1" }),
        pid: 12,
        integrationVersion: "0.0.1",
        integrationProtocol: 8,
        harnessSessionId: "conv-main",
        startedAt: 220,
        placedAt: 225,
        readyAt: 235,
        endedAt: null,
        endReason: null,
      })
      assert.deepStrictEqual(rows[1], {
        id: subProcess,
        harness: "pi",
        provider: "cpa",
        model: "grok",
        routing: JSON.stringify({ decidedBy: { harness: "choice" }, trace: [] }),
        runtime: "herdr",
        terminal: JSON.stringify({ id: "w1:p2" }),
        pid: 20,
        integrationVersion: null,
        integrationProtocol: null,
        harnessSessionId: null,
        startedAt: 302,
        placedAt: 302,
        readyAt: null,
        endedAt: 330,
        endReason: "restart",
      })
      assert.strictEqual(rows[2]!.endReason, "launch_failed")
      assert.strictEqual(rows[2]!.placedAt, null)
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a placed process that fails to launch stays the session's current process", () =>
    Effect.gen(function* () {
      const { sql, bus } = yield* story

      const placed = yield* bus.transaction(
        Effect.gen(function* () {
          const id = 3
          yield* bus.publish(ProcessEvent.Started, {
            sessionId: SUB,
            processId: id,
            harness: "pi",
            runtime: "herdr",
            terminal: { id: "w1:p3" },
          })
          yield* bus.publish(ProcessEvent.Ended, {
            sessionId: SUB,
            processId: id,
            reason: "launch_failed",
          })

          return id
        }),
      )

      assert.deepStrictEqual(yield* rowsOf(sql, `SELECT process_id FROM session WHERE id = '${SUB}'`), [
        { processId: placed },
      ])
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a first placeholder that fails to launch stays the session's process when there is no other", () =>
    Effect.gen(function* () {
      const { bus, sql } = yield* ledger

      const placeholder = yield* bus.transaction(
        Effect.gen(function* () {
          yield* bus.publish(ProjectEvent.Created, { projectId: P, repositories: [] })
          yield* bus.publish(SessionEvent.Created, {
            sessionId: SUB,
            project: P,
            agent: "subagent",
            name: "s",
            directory: "",
          })

          const id = 1
          yield* bus.publish(ProcessEvent.Started, {
            sessionId: SUB,
            processId: id,
            harness: "pi",
            runtime: "herdr",
          })
          yield* bus.publish(ProcessEvent.Ended, {
            sessionId: SUB,
            processId: id,
            reason: "launch_failed",
          })

          return id
        }),
      )

      assert.deepStrictEqual(yield* rowsOf(sql, `SELECT process_id FROM session WHERE id = '${SUB}'`), [
        { processId: placeholder },
      ])
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a second live process for one session fails the transaction", () =>
    Effect.gen(function* () {
      const { sql, bus } = yield* story
      const before = yield* eventCount(sql)

      const exit = yield* bus
        .transaction(
          bus.publish(ProcessEvent.Started, { sessionId: MAIN, processId: 2, harness: "pi", runtime: "herdr" }),
        )
        .pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(yield* eventCount(sql), before)
    }).pipe(Effect.provide(memory())),
  )

  it.effect("execution events: started, ended once with its reply", () =>
    Effect.gen(function* () {
      const { sql, bus, execution, typed, subProcess, mainProcess } = yield* story
      yield* bus.transaction(
        bus.publish(
          SessionEvent.ExecutionUnresolved,
          { sessionId: SUB, executionId: execution, observation: "lost" },
          { at: 999 },
        ),
      )
      assert.deepStrictEqual(
        yield* rowsOf(
          sql,
          "SELECT session_id, id, process_id, typed, started_at, outcome, failure, reply, ended_at FROM execution ORDER BY started_at",
        ),
        [
          {
            sessionId: SUB,
            id: execution,
            processId: subProcess,
            typed: null,
            startedAt: 310,
            outcome: "completed",
            failure: null,
            reply: "All tests pass.",
            endedAt: 321,
          },
          {
            sessionId: MAIN,
            id: typed,
            processId: mainProcess,
            typed: "hello",
            startedAt: 540,
            outcome: "failed",
            failure: "model overloaded",
            reply: null,
            endedAt: 541,
          },
        ],
      )
    }).pipe(Effect.provide(memory())),
  )

  it.effect("inbox events: queued and moved, with the execution that took a row", () =>
    Effect.gen(function* () {
      const { sql, task, execution, result, notice } = yield* story
      assert.deepStrictEqual(
        yield* rowsOf(
          sql,
          `SELECT id, recipient_session_id AS session_id, sender_session_id, about_session_id, content, request_id AS request, transfer_id,
            status, recipient_execution_id FROM inbox ORDER BY recipient_session_id = '${SUB}' DESC, id`,
        ),
        [
          {
            id: task,
            sessionId: SUB,
            senderSessionId: MAIN,
            aboutSessionId: null,
            content: "fix it",
            request: "r-1",
            transferId: null,
            status: "delivered",
            recipientExecutionId: execution,
          },
          {
            id: result,
            sessionId: MAIN,
            senderSessionId: null,
            aboutSessionId: SUB,
            content: "",
            request: null,
            transferId: null,
            status: "delivering",
            recipientExecutionId: null,
          },
          {
            id: notice,
            sessionId: MAIN,
            senderSessionId: null,
            aboutSessionId: null,
            content: "remote done",
            request: null,
            transferId: ITEM,
            status: "pending",
            recipientExecutionId: null,
          },
        ],
      )
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a second notice with the same peer item fails the transaction", () =>
    Effect.gen(function* () {
      const { bus } = yield* story

      const exit = yield* bus
        .transaction(
          bus.publish(SessionEvent.InboxEnqueued, {
            sessionId: MAIN,
            messageId: 3,
            sender: { type: "vibest" },
            content: "again",
            transferId: ITEM,
          }),
        )
        .pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(exit))
    }).pipe(Effect.provide(memory())),
  )

  it.effect("machine, remote and outbox events", () =>
    Effect.gen(function* () {
      const { sql, bus } = yield* story
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT * FROM machine"), [])
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT * FROM remote"), [{ id: PEER, name: "mac2", connectedAt: 170 }])

      const [queued] = yield* sql<{
        seq: number
      }>`SELECT seq FROM event WHERE type = 'remote.outbox.queued.1' ORDER BY seq DESC`

      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT * FROM outbox WHERE acked_at IS NULL"), [
        {
          id: ITEM_2,
          seq: queued!.seq,
          remoteId: PEER,
          recipient: null,
          sessionId: REMOTE,
          kind: "send",
          content: "archived",
          fromSession: null,
          fromAgent: null,
          fromTitle: null,
          fromMachine: null,
          executionId: null,
          createdAt: 511,
          ackedAt: null,
        },
      ])
      yield* bus.transaction(
        bus.publish(MachineEvent.Added, { name: "mc", target: "mc", remote: MACHINE }, { at: 900 }),
      )
      yield* bus.transaction(bus.publish(MachineEvent.Connected, { name: "mc" }, { at: 950 }))
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT * FROM machine"), [
        { name: "mc", target: "mc", remoteId: MACHINE, connectedAt: 950, createdAt: 900 },
      ])
    }).pipe(Effect.provide(memory())),
  )

  it.effect("the read model of the whole story equals a replay of its log", () =>
    Effect.gen(function* () {
      const { sql } = yield* story
      assert.strictEqual(yield* replayDifference(sql), undefined)
    }).pipe(Effect.provide(memory())),
  )

  it.effect("equalToReplay names the first row that differs from the replay", () =>
    Effect.gen(function* () {
      const { sql } = yield* story
      yield* sql`UPDATE session SET name = 'tampered' WHERE id = ${SUB}`
      const difference = yield* replayDifference(sql)
      assert.include(difference, "session row")
      assert.include(difference, "tampered")
    }).pipe(Effect.provide(memory())),
  )
})

describe("bus", () => {
  it.effect("publish outside a transaction commits and publishes it on its own", () =>
    Effect.gen(function* () {
      const { bus, published, sql } = yield* ledger
      yield* bus.publish(MachineEvent.Connected, { name: "mb" })
      assert.strictEqual(yield* eventCount(sql), 1)
      assert.deepStrictEqual(
        (yield* published).map((event) => event.type),
        ["machine.connected"],
      )
    }).pipe(Effect.provide(memory())),
  )

  it.effect("publish from another fiber than the transaction's dies", () =>
    Effect.gen(function* () {
      const { bus } = yield* ledger

      const exit = yield* bus
        .transaction(
          Effect.forkChild(bus.publish(MachineEvent.Connected, { name: "mb" })).pipe(Effect.flatMap(Fiber.join)),
        )
        .pipe(Effect.exit)

      assert.isTrue(Exit.hasDies(exit))
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a payload with a key the definition does not have dies and writes nothing", () =>
    Effect.gen(function* () {
      const { bus, sql } = yield* ledger

      const exit = yield* bus
        .transaction(bus.publish(MachineEvent.Connected, { name: "mb", extra: 1 } as never))
        .pipe(Effect.exit)

      assert.isTrue(Exit.hasDies(exit))
      assert.strictEqual(yield* eventCount(sql), 0)
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a rolled back commit publishes nothing; nested commits publish once, in seq order, after the outer", () =>
    Effect.gen(function* () {
      const { bus, published } = yield* ledger

      const failed = yield* bus
        .transaction(
          Effect.andThen(bus.publish(MachineEvent.RemoteSeen, { remoteId: PEER, name: "a" }), Effect.fail("stop")),
        )
        .pipe(Effect.exit)

      assert.isTrue(Exit.isFailure(failed))
      assert.deepStrictEqual(yield* published, [])
      yield* bus.transaction(
        Effect.gen(function* () {
          yield* bus.publish(MachineEvent.Added, { name: "mb", target: "mb", remote: MACHINE })
          yield* bus.transaction(bus.publish(MachineEvent.Connected, { name: "mb" }))
          assert.deepStrictEqual(yield* published, [])
        }),
      )
      const events = (yield* published).filter((event): event is DurableEvent => "durable" in event)
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["machine.added", "machine.connected"],
      )
      assert.isTrue(events[0]!.durable.seq < events[1]!.durable.seq)
    }).pipe(Effect.provide(memory())),
  )

  it.effect("after-commit effects run only once the outermost transaction commits", () =>
    Effect.gen(function* () {
      const { bus } = yield* ledger
      const ran: Array<string> = []
      const mark = (name: string) => bus.afterCommit(() => void ran.push(name))
      yield* bus.transaction(mark("rolled back").pipe(Effect.andThen(Effect.fail("stop")))).pipe(Effect.exit)
      assert.deepStrictEqual(ran, [])
      yield* bus.transaction(
        Effect.gen(function* () {
          yield* bus.transaction(mark("nested"))
          assert.deepStrictEqual(ran, [])
        }),
      )
      assert.deepStrictEqual(ran, ["nested"])
      yield* mark("outside")
      assert.deepStrictEqual(ran, ["nested", "outside"])
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a commit publishes its events and then one change signal per session and per project it touched", () =>
    Effect.gen(function* () {
      const { bus, published } = yield* ledger
      yield* bus.transaction(
        Effect.gen(function* () {
          yield* bus.publish(ProjectEvent.Created, { projectId: P, repositories: [] })
          yield* bus.publish(SessionEvent.Created, {
            sessionId: MAIN,
            project: P,
            agent: "main",
            name: "main",
            directory: "",
          })
          yield* bus.publish(SessionEvent.Renamed, { sessionId: MAIN, name: "again" })
        }),
      )
      assert.deepStrictEqual(
        (yield* published).map((event) => event.type),
        ["project.created", "session.created", "session.renamed", "project.changed", "session.changed"],
      )
    }).pipe(Effect.provide(memory())),
  )

  it.effect("each durable event numbers independently per aggregate_id and stores versioned type", () =>
    Effect.gen(function* () {
      const { bus, sql } = yield* ledger
      yield* bus.transaction(
        Effect.gen(function* () {
          yield* bus.publish(ProjectEvent.Created, { projectId: P, repositories: [] })
          yield* bus.publish(SessionEvent.Created, {
            sessionId: MAIN,
            project: P,
            agent: "main",
            name: "main",
            directory: "",
          })
          yield* bus.publish(SessionEvent.InboxEnqueued, {
            sessionId: MAIN,
            messageId: 1,
            sender: { type: "agent", session: MAIN },
            content: "hi",
          })
          yield* bus.publish(MachineEvent.RemoteSeen, { remoteId: PEER, name: "a" })
          yield* bus.publish(ProjectEvent.Moved, {
            projectId: P,
            from: "/a",
            to: "/b",
            repositories: [],
          })
        }),
      )
      assert.deepStrictEqual(
        yield* rowsOf(sql, "SELECT position, aggregate_id, seq, type FROM event ORDER BY position"),
        [
          { position: 1, aggregateId: P, seq: 1, type: "project.created.1" },
          { position: 2, aggregateId: MAIN, seq: 1, type: "session.created.1" },
          { position: 3, aggregateId: MAIN, seq: 2, type: "session.inbox.enqueued.1" },
          { position: 4, aggregateId: PEER, seq: 1, type: "remote.seen.1" },
          { position: 5, aggregateId: P, seq: 2, type: "project.moved.1" },
        ],
      )
    }).pipe(Effect.provide(memory())),
  )

  it.effect("projects and publishes the stored form, so routing given in another key order equals its replay", () =>
    Effect.gen(function* () {
      const { bus, sql, published } = yield* ledger

      const routing = {
        trace: [{ ms: 1, plugin: "p", hook: "h", outcome: "ok", changes: [{ to: "pi", field: "harness" }] }],
        decidedBy: {},
      }

      yield* bus.transaction(
        Effect.gen(function* () {
          yield* bus.publish(ProjectEvent.Created, { projectId: P, repositories: [] })
          yield* bus.publish(SessionEvent.Created, {
            sessionId: MAIN,
            project: P,
            agent: "main",
            name: "main",
            directory: "",
          })
          yield* bus.publish(ProcessEvent.Started, {
            sessionId: MAIN,
            processId: 1,
            harness: "pi",
            runtime: "herdr",
            routing: routing as never,
          })
        }),
      )

      const stored =
        '{"decidedBy":{},"trace":[{"plugin":"p","hook":"h","outcome":"ok","ms":1,"changes":[{"field":"harness","to":"pi"}]}]}'

      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT routing FROM process"), [{ routing: stored }])
      const started = (yield* published).find((event) => event.type === "process.started")!
      assert.strictEqual(JSON.stringify((started as DurableEventOf<"process.started">).data.routing), stored)
      assert.strictEqual(yield* replayDifference(sql), undefined)
    }).pipe(Effect.provide(memory())),
  )

  it.effect("an event may be earlier than the one before it", () =>
    Effect.gen(function* () {
      const { bus, sql } = yield* ledger
      yield* bus.transaction(
        Effect.gen(function* () {
          yield* bus.publish(MachineEvent.Added, { name: "mb", target: "mb", remote: MACHINE }, { at: 500 })
          yield* bus.publish(MachineEvent.Connected, { name: "mb" }, { at: 400 })
        }),
      )
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT created FROM event ORDER BY seq"), [
        { created: 500 },
        { created: 400 },
      ])
    }).pipe(Effect.provide(memory())),
  )

  it.effect("the log refuses updates and never reuses a position or sequence", () =>
    Effect.gen(function* () {
      const { bus, sql } = yield* ledger
      const emitConnected = bus.transaction(bus.publish(MachineEvent.Connected, { name: "mb" }))
      const first = yield* emitConnected
      const second = yield* emitConnected
      const update = yield* sql`UPDATE event SET created = 0 WHERE seq = ${first.durable.seq}`.pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(update))
      yield* sql`DELETE FROM event WHERE seq = ${second.durable.seq}`
      const third = yield* emitConnected
      assert.strictEqual(third.durable.seq, 3)
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT position, seq FROM event ORDER BY position"), [
        { position: 1, seq: 1 },
        { position: 3, seq: 3 },
      ])
    }).pipe(Effect.provide(memory())),
  )
})

describe("project", () => {
  it.effect("a replay reaching an event type no domain registered a projector for fails and names it", () =>
    Effect.gen(function* () {
      yield* installBaseline
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO event (id, aggregate_id, seq, created, type, data)
        VALUES ('evt_test_unprojected', ${PEER}, 1, 1, 'remote.seen.1', ${JSON.stringify({ remoteId: PEER, name: "a" })})`
      const error = yield* (yield* Bus.Service).rebuild.pipe(Effect.flip)
      assert.strictEqual(error._tag, "InvalidDurableEvent")
      assert.include(error.message, `event ${PEER} 1: remote.seen.1 has no projector`)
    }).pipe(Effect.provide(Bus.layer.pipe(Layer.provideMerge(Layer.fresh(memorySqlite))))),
  )
})

describe("delivery order", () => {
  it.effect("a subscriber publishing a follow-up event does not overtake the rest of the batch", () =>
    Effect.gen(function* () {
      yield* installBaseline
      const bus = yield* Bus.Service
      const first = yield* bus.subscribe([MachineEvent.RemoteSeen])
      const second = yield* bus.subscribe([MachineEvent.RemoteSeen, MachineEvent.Connected])
      yield* Stream.fromSubscription(first).pipe(
        Stream.take(1),
        Stream.runForEach(() => bus.publish(MachineEvent.Connected, { name: "mb" })),
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      yield* bus.transaction(
        Effect.gen(function* () {
          yield* bus.publish(MachineEvent.RemoteSeen, { remoteId: PEER, name: "a" })
          yield* bus.publish(MachineEvent.RemoteSeen, { remoteId: PEER, name: "b" })
        }),
      )
      const seen = yield* Effect.forEach([1, 2, 3], () => PubSub.take(second))
      assert.deepStrictEqual(
        seen.map((event) => event.type),
        ["remote.seen", "remote.seen", "machine.connected"],
      )
    }).pipe(Effect.provide(memory()), Effect.scoped),
  )
})
