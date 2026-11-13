import { assert, describe, it } from "@effect/vitest"
import { withChanges } from "@vibest/core/bus"
import { equalToReplay, followFacts, installLedger, makeJournal, rebuild } from "@vibest/core/journal"
import { PROJECTION_VERSION } from "@vibest/core/projectors"
import { Catalog, type Fact } from "@vibest/schema/event"
import { Effect, Exit, Fiber, Layer, Queue, Stream } from "effect"
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

const memory = () => Layer.fresh(memorySqlite)

const ledger = Effect.gen(function* () {
  yield* installLedger
  const published: Array<ReadonlyArray<Fact>> = []
  const journal = yield* makeJournal((facts) => Effect.sync(() => void published.push(facts)))
  const sql = yield* SqlClient.SqlClient
  return { journal, published, sql }
})

const replayDifference = (sql: SqlClient.SqlClient) => equalToReplay(sql).pipe(Effect.provide(memory()))

const eventCount = (sql: SqlClient.SqlClient) =>
  sql<{ n: number }>`SELECT count(*) AS n FROM event`.pipe(Effect.map((rows) => rows[0]!.n))

const story = Effect.gen(function* () {
  const { journal, sql } = yield* ledger
  const { emit, commit } = journal
  const ids = yield* commit(
    Effect.gen(function* () {
      yield* emit(Catalog["machine.added"], { at: 100, data: { name: "mb", target: "root@mb", vibestd: MACHINE } })
      yield* emit(Catalog["machine.connected"], { at: 150, data: { name: "mb" } })
      yield* emit(Catalog["peer.seen"], { at: 160, data: { id: PEER, name: "mac" } })
      yield* emit(Catalog["peer.seen"], { at: 170, data: { id: PEER, name: "mac2" } })
      yield* emit(Catalog["project.created"], {
        projectId: P,
        at: 200,
        data: { directory: "/w/app", repositories: [{ path: "/w/app", remote: "git@x:app.git" }] },
      })
      yield* emit(Catalog["session.created"], {
        sessionId: MAIN,
        at: 210,
        data: { project: P, agent: "main", name: "main", directory: "" },
      })
      yield* emit(Catalog["project.entry_changed"], { projectId: P, at: 211, data: { session: MAIN } })
      yield* emit(Catalog["session.directory_changed"], { sessionId: MAIN, at: 212, data: { directory: "/w/app" } })
      const mainProcess = yield* emit(Catalog["process.started"], {
        sessionId: MAIN,
        at: 220,
        data: { harness: "claude", runtime: "herdr" },
      })
      yield* emit(Catalog["process.placed"], {
        sessionId: MAIN,
        at: 225,
        data: { process: mainProcess, terminal: "w1:p1", pid: 10 },
      })
      yield* emit(Catalog["process.ready"], {
        sessionId: MAIN,
        at: 230,
        data: { process: mainProcess, pid: 11, integration: { version: "0.0.1", protocol: 8 } },
      })
      yield* emit(Catalog["process.ready"], { sessionId: MAIN, at: 235, data: { process: mainProcess } })
      yield* emit(Catalog["process.pid"], { sessionId: MAIN, at: 236, data: { process: mainProcess, pid: 12 } })
      yield* emit(Catalog["process.conversation"], {
        sessionId: MAIN,
        at: 237,
        data: { process: mainProcess, conversation: "conv-main" },
      })

      yield* emit(Catalog["session.created"], {
        sessionId: SUB,
        at: 300,
        data: { project: P, agent: "subagent", name: "tests", directory: "/w/app/wt", parent: MAIN },
      })
      const task = yield* emit(Catalog["inbox.queued"], {
        sessionId: SUB,
        at: 301,
        data: { kind: "task", recipient: SUB, sender: MAIN, content: "fix it", status: "delivered", request: "r-1" },
      })
      const subProcess = yield* emit(Catalog["process.started"], {
        sessionId: SUB,
        at: 302,
        data: {
          harness: "pi",
          provider: "cpa",
          model: "grok",
          routing: { decidedBy: { harness: "choice" }, trace: [] },
          runtime: "herdr",
          terminal: "w1:p2",
          pid: 20,
        },
      })
      const execution = yield* emit(Catalog["execution.started"], {
        sessionId: SUB,
        at: 310,
        data: { process: subProcess },
      })
      yield* emit(Catalog["inbox.moved"], {
        sessionId: SUB,
        at: 311,
        data: { inbox: task, to: "delivered", execution: execution },
      })
      yield* emit(Catalog["execution.ended"], {
        sessionId: SUB,
        at: 321,
        data: { execution: execution, outcome: "completed", reply: "All tests pass." },
      })
      const result = yield* emit(Catalog["inbox.queued"], {
        sessionId: MAIN,
        at: 322,
        data: { kind: "notice", recipient: MAIN, sender: SUB, content: "", status: "pending" },
      })
      yield* emit(Catalog["inbox.moved"], { sessionId: MAIN, at: 323, data: { inbox: result, to: "delivering" } })
      yield* emit(Catalog["inbox.moved"], { sessionId: MAIN, at: 324, data: { inbox: result, to: "delivered" } })

      yield* emit(Catalog["process.ended"], {
        sessionId: SUB,
        at: 330,
        data: { process: subProcess, reason: "limited" },
      })
      const placeholder = yield* emit(Catalog["process.started"], {
        sessionId: SUB,
        at: 331,
        data: { harness: "claude", runtime: "herdr" },
      })
      yield* emit(Catalog["process.ended"], {
        sessionId: SUB,
        at: 332,
        data: { process: placeholder, reason: "launch_failed" },
      })
      yield* emit(Catalog["session.renamed"], { sessionId: SUB, at: 333, data: { name: "fix-tests" } })

      yield* emit(Catalog["project.repositories_changed"], {
        projectId: P,
        at: 400,
        data: { repositories: [{ path: "/w/app/lib" }] },
      })
      yield* emit(Catalog["project.moved"], {
        projectId: P,
        at: 410,
        data: { from: "/w/app", to: "/src/app", repositories: [{ path: "/src/app", remote: "git@x:app.git" }] },
      })

      yield* emit(Catalog["session.created"], {
        sessionId: REMOTE,
        at: 500,
        data: {
          project: P,
          agent: "subagent",
          name: "remote",
          directory: "/src/app",
          origin: { peer: PEER, project: OTHER_PROJECT, session: MAIN },
        },
      })
      yield* emit(Catalog["outbox.queued"], {
        at: 510,
        data: { id: ITEM, peer: PEER, session: REMOTE, content: "done" },
      })
      yield* emit(Catalog["outbox.queued"], {
        at: 511,
        data: { id: ITEM_2, peer: PEER, session: REMOTE, kind: "send", content: "archived" },
      })
      yield* emit(Catalog["outbox.acked"], { at: 520, data: { peer: PEER, ids: [ITEM] } })
      const notice = yield* emit(Catalog["inbox.queued"], {
        sessionId: MAIN,
        at: 530,
        data: { kind: "notice", recipient: MAIN, content: "remote done", status: "pending", peerItem: ITEM },
      })
      const typed = yield* emit(Catalog["execution.started"], {
        sessionId: MAIN,
        at: 540,
        data: { process: mainProcess, typed: "hello" },
      })
      yield* emit(Catalog["execution.ended"], {
        sessionId: MAIN,
        at: 541,
        data: { execution: typed, outcome: "failed", failure: { message: "model overloaded" } },
      })
      yield* emit(Catalog["machine.removed"], { at: 600, data: { name: "mb" } })
      return { mainProcess, task, subProcess, execution, result, placeholder, notice, typed }
    }),
  )
  return { ...ids, sql, journal }
})

const rowsOf = <A extends object>(sql: SqlClient.SqlClient, query: string) => sql.unsafe<A>(query)

describe("journal projectors", () => {
  it.effect("project facts: created, repositories, entry, move", () =>
    Effect.gen(function* () {
      const { sql } = yield* story
      const [project] = yield* rowsOf<{ directory: string; entrySessionId: string }>(
        sql,
        "SELECT directory, entry_session_id FROM project",
      )
      assert.strictEqual(project!.directory, "/src/app")
      assert.strictEqual(project!.entrySessionId, MAIN)
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
      const { journal, sql } = yield* ledger
      yield* journal.commit(
        Effect.gen(function* () {
          yield* journal.emit(Catalog["project.created"], {
            projectId: P,
            data: { directory: "/a", repositories: [{ path: "/a" }] },
          })
          yield* journal.emit(Catalog["project.created"], { projectId: OTHER_PROJECT, data: { repositories: [] } })
          yield* journal.emit(Catalog["project.repositories_changed"], {
            projectId: OTHER_PROJECT,
            data: { repositories: [{ path: "/a", remote: "r" }] },
          })
          yield* journal.emit(Catalog["project.repositories_changed"], {
            projectId: P,
            data: { repositories: [{ path: "/a", remote: "mine" }] },
          })
        }),
      )
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT project_id, path, remote_url FROM project_repository"), [
        { projectId: P, path: "/a", remoteUrl: "mine" },
      ])
    }).pipe(Effect.provide(memory())),
  )

  it.effect("session facts: created, renamed, origin, ended and current process", () =>
    Effect.gen(function* () {
      const { sql, subProcess, mainProcess } = yield* story
      const rows = yield* rowsOf<Record<string, unknown>>(
        sql,
        `SELECT id, name, agent, parent_session_id, origin_peer,
          origin_project, origin_session, created_at, ended_at, process_id, active_at
        FROM session ORDER BY created_at`,
      )
      assert.deepStrictEqual(rows, [
        {
          id: MAIN,
          name: "main",
          agent: "main",
          parentSessionId: null,
          originPeer: null,
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
          originPeer: null,
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
          originPeer: PEER,
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

  it.effect("session.ended keeps the first end time and drops the session's outbox", () =>
    Effect.gen(function* () {
      const { sql, journal } = yield* story
      yield* journal.commit(
        Effect.gen(function* () {
          yield* journal.emit(Catalog["session.ended"], { sessionId: REMOTE, at: 700, data: { reason: "archived" } })
          yield* journal.emit(Catalog["session.ended"], { sessionId: REMOTE, at: 800, data: { reason: "replaced" } })
        }),
      )
      assert.deepStrictEqual(yield* rowsOf(sql, `SELECT ended_at FROM session WHERE id = '${REMOTE}'`), [
        { endedAt: 700 },
      ])
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT id FROM outbox"), [])
    }).pipe(Effect.provide(memory())),
  )

  it.effect("process facts: placed, ready, pid, conversation, ended", () =>
    Effect.gen(function* () {
      const { sql, mainProcess, subProcess } = yield* story
      const rows = yield* rowsOf<Record<string, unknown>>(
        sql,
        `SELECT id, harness, provider, model, routing, runtime, terminal, pid, integration_version,
          integration_protocol, conversation, started_at, placed_at, ready_at, ended_at, end_reason
        FROM process ORDER BY started_at`,
      )
      assert.deepStrictEqual(rows[0], {
        id: mainProcess,
        harness: "claude",
        provider: null,
        model: null,
        routing: null,
        runtime: "herdr",
        terminal: "w1:p1",
        pid: 12,
        integrationVersion: "0.0.1",
        integrationProtocol: 8,
        conversation: "conv-main",
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
        terminal: "w1:p2",
        pid: 20,
        integrationVersion: null,
        integrationProtocol: null,
        conversation: null,
        startedAt: 302,
        placedAt: 302,
        readyAt: null,
        endedAt: 330,
        endReason: "limited",
      })
      assert.strictEqual(rows[2]!.endReason, "launch_failed")
      assert.strictEqual(rows[2]!.placedAt, null)
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a placed process that fails to launch stays the session's current process", () =>
    Effect.gen(function* () {
      const { sql, journal } = yield* story
      const placed = yield* journal.commit(
        Effect.gen(function* () {
          const id = yield* journal.emit(Catalog["process.started"], {
            sessionId: SUB,
            data: { harness: "pi", runtime: "herdr", terminal: "w1:p3" },
          })
          yield* journal.emit(Catalog["process.ended"], {
            sessionId: SUB,
            data: { process: id, reason: "launch_failed" },
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
      const { journal, sql } = yield* ledger
      const placeholder = yield* journal.commit(
        Effect.gen(function* () {
          yield* journal.emit(Catalog["project.created"], { projectId: P, data: { repositories: [] } })
          yield* journal.emit(Catalog["session.created"], {
            sessionId: SUB,
            data: { project: P, agent: "subagent", name: "s", directory: "" },
          })
          const id = yield* journal.emit(Catalog["process.started"], {
            sessionId: SUB,
            data: { harness: "pi", runtime: "herdr" },
          })
          yield* journal.emit(Catalog["process.ended"], {
            sessionId: SUB,
            data: { process: id, reason: "launch_failed" },
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
      const { sql, journal } = yield* story
      const before = yield* eventCount(sql)
      const exit = yield* journal
        .commit(
          journal.emit(Catalog["process.started"], { sessionId: MAIN, data: { harness: "pi", runtime: "herdr" } }),
        )
        .pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(yield* eventCount(sql), before)
    }).pipe(Effect.provide(memory())),
  )

  it.effect("execution facts: started, ended once with its reply", () =>
    Effect.gen(function* () {
      const { sql, journal, execution, typed, subProcess, mainProcess } = yield* story
      yield* journal.commit(
        journal.emit(Catalog["execution.ended"], {
          sessionId: SUB,
          at: 999,
          data: { execution: execution, outcome: "lost" },
        }),
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

  it.effect("inbox facts: queued and moved, with the execution that took a row", () =>
    Effect.gen(function* () {
      const { sql, task, execution, result, notice } = yield* story
      assert.deepStrictEqual(
        yield* rowsOf(
          sql,
          `SELECT id, session_id, sender_session_id, kind, content, request, peer_item,
            status, execution_id FROM inbox ORDER BY session_id = '${SUB}' DESC, id`,
        ),
        [
          {
            id: task,
            sessionId: SUB,
            senderSessionId: MAIN,
            kind: "task",
            content: "fix it",
            request: "r-1",
            peerItem: null,
            status: "delivered",
            executionId: execution,
          },
          {
            id: result,
            sessionId: MAIN,
            senderSessionId: SUB,
            kind: "notice",
            content: "",
            request: null,
            peerItem: null,
            status: "delivered",
            executionId: null,
          },
          {
            id: notice,
            sessionId: MAIN,
            senderSessionId: null,
            kind: "notice",
            content: "remote done",
            request: null,
            peerItem: ITEM,
            status: "pending",
            executionId: null,
          },
        ],
      )
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a second notice with the same peer item fails the transaction", () =>
    Effect.gen(function* () {
      const { journal } = yield* story
      const exit = yield* journal
        .commit(
          journal.emit(Catalog["inbox.queued"], {
            sessionId: MAIN,
            data: { kind: "notice", recipient: MAIN, content: "again", status: "pending", peerItem: ITEM },
          }),
        )
        .pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
    }).pipe(Effect.provide(memory())),
  )

  it.effect("machine, peer and outbox facts", () =>
    Effect.gen(function* () {
      const { sql, journal } = yield* story
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT * FROM machine"), [])
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT * FROM peer"), [{ id: PEER, name: "mac2", connectedAt: 170 }])
      const [queued] = yield* sql<{ seq: number }>`SELECT seq FROM event WHERE type = 'outbox.queued' ORDER BY seq DESC`
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT * FROM outbox"), [
        {
          id: ITEM_2,
          seq: queued!.seq,
          peerId: PEER,
          recipient: null,
          sessionId: REMOTE,
          kind: "send",
          content: "archived",
          createdAt: 511,
        },
      ])
      yield* journal.commit(
        journal.emit(Catalog["machine.added"], { at: 900, data: { name: "mc", target: "mc", vibestd: MACHINE } }),
      )
      yield* journal.commit(journal.emit(Catalog["machine.connected"], { at: 950, data: { name: "mc" } }))
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT * FROM machine"), [
        { name: "mc", target: "mc", vibestdId: MACHINE, connectedAt: 950, createdAt: 900 },
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

describe("journal", () => {
  it.effect("emit outside commit dies", () =>
    Effect.gen(function* () {
      const { journal } = yield* ledger
      const exit = yield* journal.emit(Catalog["machine.connected"], { data: { name: "mb" } }).pipe(Effect.exit)
      assert.isTrue(Exit.hasDies(exit))
    }).pipe(Effect.provide(memory())),
  )

  it.effect("emit from another fiber than the transaction's dies", () =>
    Effect.gen(function* () {
      const { journal } = yield* ledger
      const exit = yield* journal
        .commit(
          Effect.forkChild(journal.emit(Catalog["machine.connected"], { data: { name: "mb" } })).pipe(
            Effect.flatMap(Fiber.join),
          ),
        )
        .pipe(Effect.exit)
      assert.isTrue(Exit.hasDies(exit))
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a payload with a key the definition does not have dies and writes nothing", () =>
    Effect.gen(function* () {
      const { journal, sql } = yield* ledger
      const exit = yield* journal
        .commit(journal.emit(Catalog["machine.connected"], { data: { name: "mb", extra: 1 } as never }))
        .pipe(Effect.exit)
      assert.isTrue(Exit.hasDies(exit))
      assert.strictEqual(yield* eventCount(sql), 0)
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a rolled back commit publishes nothing; nested commits publish once, in seq order, after the outer", () =>
    Effect.gen(function* () {
      const { journal, published } = yield* ledger
      const failed = yield* journal
        .commit(
          Effect.andThen(journal.emit(Catalog["peer.seen"], { data: { id: PEER, name: "a" } }), Effect.fail("stop")),
        )
        .pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(failed))
      assert.deepStrictEqual(published, [])
      yield* journal.commit(
        Effect.gen(function* () {
          yield* journal.emit(Catalog["machine.added"], { data: { name: "mb", target: "mb", vibestd: MACHINE } })
          yield* journal.commit(journal.emit(Catalog["machine.connected"], { data: { name: "mb" } }))
          assert.deepStrictEqual(published, [])
        }),
      )
      assert.deepStrictEqual(
        published.map((facts) => facts.map((fact) => fact.type)),
        [["machine.added", "machine.connected"]],
      )
      assert.isTrue(published[0]![0]!.seq < published[0]![1]!.seq)
    }).pipe(Effect.provide(memory())),
  )

  it.effect("after-commit effects run only once the outermost transaction commits", () =>
    Effect.gen(function* () {
      const { journal } = yield* ledger
      const ran: Array<string> = []
      const mark = (name: string) => journal.afterCommit(() => void ran.push(name))
      yield* journal.commit(mark("rolled back").pipe(Effect.andThen(Effect.fail("stop")))).pipe(Effect.exit)
      assert.deepStrictEqual(ran, [])
      yield* journal.commit(
        Effect.gen(function* () {
          yield* journal.commit(mark("nested"))
          assert.deepStrictEqual(ran, [])
        }),
      )
      assert.deepStrictEqual(ran, ["nested"])
      yield* mark("outside")
      assert.deepStrictEqual(ran, ["nested", "outside"])
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a commit publishes its facts and then one change signal per session and per project it touched", () =>
    Effect.gen(function* () {
      yield* installLedger
      const published: Array<ReadonlyArray<unknown>> = []
      const journal = yield* makeJournal((events) => Effect.sync(() => void published.push(withChanges(events))))
      yield* journal.commit(
        Effect.gen(function* () {
          yield* journal.emit(Catalog["project.created"], { projectId: P, data: { repositories: [] } })
          yield* journal.emit(Catalog["session.created"], {
            sessionId: MAIN,
            data: { project: P, agent: "main", name: "main", directory: "" },
          })
          yield* journal.emit(Catalog["session.renamed"], { sessionId: MAIN, data: { name: "again" } })
        }),
      )
      assert.deepStrictEqual(
        published[0]!.map((event) => (event as { type: string }).type),
        ["project.created", "session.created", "session.renamed", "project.changed", "session.changed"],
      )
    }).pipe(Effect.provide(memory())),
  )

  it.effect("each fact numbers on in its own aggregate: a session, a project, or the ledger", () =>
    Effect.gen(function* () {
      const { journal, sql } = yield* ledger
      yield* journal.commit(
        Effect.gen(function* () {
          yield* journal.emit(Catalog["project.created"], { projectId: P, data: { repositories: [] } })
          yield* journal.emit(Catalog["session.created"], {
            sessionId: MAIN,
            data: { project: P, agent: "main", name: "main", directory: "" },
          })
          yield* journal.emit(Catalog["inbox.queued"], {
            sessionId: MAIN,
            data: { kind: "send", sender: MAIN, content: "hi", status: "pending" },
          })
          yield* journal.emit(Catalog["peer.seen"], { data: { id: PEER, name: "a" } })
          yield* journal.emit(Catalog["project.entry_changed"], { projectId: P, data: { session: MAIN } })
        }),
      )
      const [ledgerId] = yield* sql<{ value: string }>`SELECT value FROM meta WHERE key = 'ledger'`
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT position, aggregate, seq, type FROM event ORDER BY position"), [
        { position: 1, aggregate: P, seq: 1, type: "project.created" },
        { position: 2, aggregate: MAIN, seq: 1, type: "session.created" },
        { position: 3, aggregate: MAIN, seq: 2, type: "inbox.queued" },
        { position: 4, aggregate: ledgerId!.value, seq: 1, type: "peer.seen" },
        { position: 5, aggregate: P, seq: 2, type: "project.entry_changed" },
      ])
    }).pipe(Effect.provide(memory())),
  )

  it.effect("projects and publishes the stored form, so routing given in another key order equals its replay", () =>
    Effect.gen(function* () {
      const { journal, sql, published } = yield* ledger
      const routing = {
        trace: [{ ms: 1, plugin: "p", hook: "h", outcome: "ok", changes: [{ to: "pi", field: "harness" }] }],
        decidedBy: {},
      }
      yield* journal.commit(
        Effect.gen(function* () {
          yield* journal.emit(Catalog["project.created"], { projectId: P, data: { repositories: [] } })
          yield* journal.emit(Catalog["session.created"], {
            sessionId: MAIN,
            data: { project: P, agent: "main", name: "main", directory: "" },
          })
          yield* journal.emit(Catalog["process.started"], {
            sessionId: MAIN,
            data: { harness: "pi", runtime: "herdr", routing: routing as never },
          })
        }),
      )
      const stored =
        '{"decidedBy":{},"trace":[{"plugin":"p","hook":"h","outcome":"ok","ms":1,"changes":[{"field":"harness","to":"pi"}]}]}'
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT routing FROM process"), [{ routing: stored }])
      const started = published.flat().find((fact) => fact.type === "process.started")!
      assert.strictEqual(JSON.stringify(started.data.routing), stored)
      assert.strictEqual(yield* replayDifference(sql), undefined)
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a session fact given a project too dies and writes nothing", () =>
    Effect.gen(function* () {
      const { journal, sql } = yield* ledger
      const exit = yield* journal
        .commit(
          Effect.gen(function* () {
            yield* journal.emit(Catalog["project.created"], { projectId: P, data: { repositories: [] } })
            yield* journal.emit(Catalog["session.created"], {
              sessionId: MAIN,
              data: { project: P, agent: "main", name: "main", directory: "" },
            })
            yield* journal.emit(Catalog["session.renamed"], {
              projectId: OTHER_PROJECT,
              sessionId: MAIN,
              data: { name: "x" },
            })
          }),
        )
        .pipe(Effect.exit)
      assert.isTrue(Exit.hasDies(exit))
      assert.strictEqual(yield* eventCount(sql), 0)
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a fact may be earlier than the one before it", () =>
    Effect.gen(function* () {
      const { journal, sql } = yield* ledger
      yield* journal.commit(
        Effect.gen(function* () {
          yield* journal.emit(Catalog["machine.added"], {
            at: 500,
            data: { name: "mb", target: "mb", vibestd: MACHINE },
          })
          yield* journal.emit(Catalog["machine.connected"], { at: 400, data: { name: "mb" } })
        }),
      )
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT at FROM event ORDER BY seq"), [{ at: 500 }, { at: 400 }])
    }).pipe(Effect.provide(memory())),
  )

  it.effect("the log refuses updates and never reuses a position", () =>
    Effect.gen(function* () {
      const { journal, sql } = yield* ledger
      const emitConnected = journal.commit(journal.emit(Catalog["machine.connected"], { data: { name: "mb" } }))
      const first = yield* emitConnected
      const second = yield* emitConnected
      const update = yield* sql`UPDATE event SET at = 0 WHERE seq = ${first}`.pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(update))
      yield* sql`DELETE FROM event WHERE seq = ${second}`
      assert.strictEqual(yield* emitConnected, second)
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT position FROM event ORDER BY position"), [
        { position: 1 },
        { position: 3 },
      ])
    }).pipe(Effect.provide(memory())),
  )
})

describe("journal rebuild", () => {
  it.effect("a database whose read model is another version replays to the same state", () =>
    Effect.gen(function* () {
      const { sql } = yield* story
      yield* sql`UPDATE meta SET value = '0' WHERE key = 'projection'`
      yield* sql`CREATE TABLE answer (execution INTEGER PRIMARY KEY)`
      yield* sql`DELETE FROM inbox`
      yield* rebuild
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT value FROM meta WHERE key = 'projection'"), [
        { value: String(PROJECTION_VERSION) },
      ])
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT name FROM sqlite_schema WHERE name = 'answer'"), [])
      assert.strictEqual(yield* replayDifference(sql), undefined)
      const [inbox] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM inbox`
      assert.strictEqual(inbox!.n, 3)
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a log row of a type outside the catalog fails the rebuild, names it and changes nothing", () =>
    Effect.gen(function* () {
      const { sql } = yield* story
      yield* sql`INSERT INTO event (aggregate, seq, at, type, data) VALUES (${SUB}, 99, 1, 'session.purged', '{}')`
      const error = yield* rebuild.pipe(Effect.flip)
      assert.strictEqual(error._tag, "UnknownFact")
      assert.include(error.message, `event ${SUB} 99`)
      const [sessions] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM session`
      assert.strictEqual(sessions!.n, 3)
    }).pipe(Effect.provide(memory())),
  )
})

describe("journal reads by cursor", () => {
  const project = { projectId: P, data: { directory: "/w/app", repositories: [] } }
  const session = (sessionId: string) => ({
    sessionId,
    data: { project: P, agent: "main", name: "n", directory: "" },
  })
  const seqs = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

  it.effect("a session read pages past 1000 facts in seq order and a log read keeps each seq rising", () =>
    Effect.gen(function* () {
      const { journal, sql } = yield* ledger
      yield* journal.commit(
        Effect.gen(function* () {
          yield* journal.emit(Catalog["project.created"], project)
          yield* journal.emit(Catalog["session.created"], session(MAIN))
          yield* journal.emit(Catalog["session.created"], session(SUB))
          for (let i = 0; i < 1100; i++)
            yield* journal.emit(Catalog["session.renamed"], {
              sessionId: i < 1050 ? MAIN : SUB,
              data: { name: `n${i}` },
            })
        }),
      )
      const read = (cursor: Parameters<typeof followFacts>[2]) =>
        Stream.runCollect(followFacts(sql, Effect.void, cursor, false)).pipe(Effect.map((rows) => Array.from(rows)))
      const own = yield* read({ session: MAIN, after: 0 })
      assert.deepStrictEqual(
        own.map((r) => r.seq),
        seqs(1051),
      )
      const all = yield* read({ log: 0 })
      assert.strictEqual(all.length, 1103)
      for (const aggregate of [P, MAIN, SUB]) {
        const mine = all.filter((r) => r.aggregate === aggregate)
        assert.deepStrictEqual(
          mine.map((r) => r.seq),
          seqs(mine.length),
        )
      }
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a follow started before two commits yields each fact once and in order", () =>
    Effect.gen(function* () {
      const { journal, sql } = yield* ledger
      const wake = yield* Queue.unbounded<void>()
      const fiber = yield* Stream.runCollect(
        followFacts(sql, Queue.take(wake), { session: MAIN, after: 0 }, true).pipe(Stream.take(2)),
      ).pipe(Effect.forkChild)
      yield* journal.commit(
        Effect.gen(function* () {
          yield* journal.emit(Catalog["project.created"], project)
          yield* journal.emit(Catalog["session.created"], session(MAIN))
        }),
      )
      yield* Queue.offer(wake, undefined)
      yield* journal.commit(journal.emit(Catalog["session.renamed"], { sessionId: MAIN, data: { name: "x" } }))
      yield* Queue.offer(wake, undefined)
      const rows = Array.from(yield* Fiber.join(fiber))
      assert.deepStrictEqual(
        rows.map((r) => [r.seq, r.type]),
        [
          [1, "session.created"],
          [2, "session.renamed"],
        ],
      )
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a finite read stops at the watermark taken when it starts and a resume starts after a seq", () =>
    Effect.gen(function* () {
      const { journal, sql } = yield* ledger
      yield* journal.commit(
        Effect.gen(function* () {
          yield* journal.emit(Catalog["project.created"], project)
          yield* journal.emit(Catalog["session.created"], session(MAIN))
        }),
      )
      const rename = (name: string) =>
        journal.commit(journal.emit(Catalog["session.renamed"], { sessionId: MAIN, data: { name } }))
      const read = (cursor: Parameters<typeof followFacts>[2]) =>
        Stream.runCollect(followFacts(sql, Effect.void, cursor, false).pipe(Stream.tap(() => rename("late")))).pipe(
          Effect.map((rows) => Array.from(rows)),
        )
      const own = yield* read({ session: MAIN, after: 0 })
      assert.deepStrictEqual(
        own.map((r) => r.seq),
        [1],
      )
      const whole = yield* read({ log: 0 })
      assert.strictEqual(whole.length, 3)
      yield* rename("x")
      const resumed = yield* Stream.runCollect(followFacts(sql, Effect.void, { session: MAIN, after: 1 }, false))
      assert.deepStrictEqual(
        Array.from(resumed).map((r) => r.seq),
        seqs(6).slice(1),
      )
    }).pipe(Effect.provide(memory())),
  )
})
