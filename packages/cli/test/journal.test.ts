import { assert, describe, it } from "@effect/vitest"
import { equalToReplay, installLedger, makeJournal, rebuild } from "@vibest/core/journal"
import { projectors, PROJECTION_VERSION } from "@vibest/core/projectors"
import { Catalog, type Fact } from "@vibest/schema/event"
import { Effect, Exit, Fiber, Layer } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

const P = "11111111-1111-4111-8111-111111111111"
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222"
const MAIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SUB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const REMOTE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const PEER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const MACHINE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const ITEM = "7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f"
const ITEM_2 = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"

const memory = () => Layer.fresh(Platform.sqlite(":memory:"))

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
      yield* emit(Catalog["peer.seen"], { at: 160, data: { id: PEER, name: "mac", callsMe: "mb" } })
      yield* emit(Catalog["peer.seen"], { at: 170, data: { id: PEER, name: "mac2", callsMe: "mb2" } })
      yield* emit(Catalog["project.created"], {
        projectId: P,
        at: 200,
        data: { directory: "/w/app", repositories: [{ path: "/w/app", remote: "git@x:app.git" }] },
      })
      yield* emit(Catalog["session.created"], {
        projectId: P,
        sessionId: MAIN,
        at: 210,
        data: { role: "main", name: "main", directory: "", archiveOnCompletion: false },
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
      const firstReady = yield* emit(Catalog["process.ready"], {
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
        projectId: P,
        sessionId: SUB,
        at: 300,
        data: {
          role: "subagent",
          name: "tests",
          directory: "/w/app/wt",
          parent: MAIN,
          reportTo: MAIN,
          archiveOnCompletion: true,
        },
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
      const turn = yield* emit(Catalog["turn.started"], { sessionId: SUB, at: 310, data: { process: subProcess } })
      yield* emit(Catalog["inbox.moved"], { sessionId: SUB, at: 311, data: { inbox: task, to: "delivered", turn } })
      const report = yield* emit(Catalog["turn.reported"], {
        sessionId: SUB,
        at: 320,
        data: { process: subProcess, harness: "pi", text: "All tests pass." },
      })
      yield* emit(Catalog["turn.ended"], { sessionId: SUB, at: 321, data: { turn, status: "completed", report } })
      const result = yield* emit(Catalog["inbox.queued"], {
        sessionId: MAIN,
        at: 322,
        data: { kind: "result", recipient: MAIN, sender: SUB, content: "", status: "pending", turn },
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
        projectId: P,
        sessionId: REMOTE,
        at: 500,
        data: {
          role: "subagent",
          name: "remote",
          directory: "/src/app",
          archiveOnCompletion: false,
          origin: { peer: PEER, project: OTHER_PROJECT, reportTo: MAIN },
        },
      })
      yield* emit(Catalog["outbox.queued"], {
        sessionId: REMOTE,
        at: 510,
        data: { id: ITEM, peer: PEER, kind: "result", content: "done" },
      })
      yield* emit(Catalog["outbox.queued"], {
        sessionId: REMOTE,
        at: 511,
        data: { id: ITEM_2, peer: PEER, kind: "notice", content: "archived" },
      })
      yield* emit(Catalog["outbox.acked"], { at: 520, data: { peer: PEER, ids: [ITEM] } })
      const notice = yield* emit(Catalog["inbox.queued"], {
        sessionId: MAIN,
        at: 530,
        data: { kind: "notice", recipient: MAIN, content: "remote done", status: "pending", peerItem: ITEM },
      })
      const typed = yield* emit(Catalog["turn.started"], {
        sessionId: MAIN,
        at: 540,
        data: { process: mainProcess, typed: "hello" },
      })
      yield* emit(Catalog["turn.ended"], {
        sessionId: MAIN,
        at: 541,
        data: { turn: typed, status: "failed", failure: { message: "model overloaded" } },
      })
      yield* emit(Catalog["machine.removed"], { at: 600, data: { name: "mb" } })
      return { mainProcess, firstReady, task, subProcess, turn, report, result, placeholder, notice, typed }
    }),
  )
  return { ...ids, sql, journal }
})

const rowsOf = <A extends object>(sql: SqlClient.SqlClient, query: string) => sql.unsafe<A>(query)

describe("journal projectors", () => {
  it("every catalog type has exactly one projector", () => {
    assert.deepStrictEqual(Object.keys(projectors).toSorted(), Object.keys(Catalog).toSorted())
  })

  it.effect("project facts: created, repositories, entry, move", () =>
    Effect.gen(function* () {
      const { sql } = yield* story
      const [project] = yield* rowsOf<{ directory: string; entrySessionId: string; seq: number }>(
        sql,
        "SELECT directory, entry_session_id, seq FROM project",
      )
      assert.strictEqual(project!.directory, "/src/app")
      assert.strictEqual(project!.entrySessionId, MAIN)
      const [moved] = yield* sql<{ seq: number }>`SELECT seq FROM event WHERE type = 'project.moved'`
      assert.strictEqual(project!.seq, moved!.seq)
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

  it.effect("session facts: created, renamed, origin, ended, current process and turn", () =>
    Effect.gen(function* () {
      const { sql, subProcess, turn, typed, mainProcess } = yield* story
      const rows = yield* rowsOf<Record<string, unknown>>(
        sql,
        `SELECT id, name, role, parent_session_id, report_to_session_id, archive_on_completion, origin_peer,
          origin_project, origin_parent, origin_report_to, created_at, ended_at, process_id, turn_id, active_at
        FROM session ORDER BY created_at`,
      )
      assert.deepStrictEqual(rows, [
        {
          id: MAIN,
          name: "main",
          role: "main",
          parentSessionId: null,
          reportToSessionId: null,
          archiveOnCompletion: 0,
          originPeer: null,
          originProject: null,
          originParent: null,
          originReportTo: null,
          createdAt: 210,
          endedAt: null,
          processId: mainProcess,
          turnId: typed,
          activeAt: 541,
        },
        {
          id: SUB,
          name: "fix-tests",
          role: "subagent",
          parentSessionId: MAIN,
          reportToSessionId: MAIN,
          archiveOnCompletion: 1,
          originPeer: null,
          originProject: null,
          originParent: null,
          originReportTo: null,
          createdAt: 300,
          endedAt: null,
          processId: subProcess,
          turnId: turn,
          activeAt: 332,
        },
        {
          id: REMOTE,
          name: "remote",
          role: "subagent",
          parentSessionId: null,
          reportToSessionId: null,
          archiveOnCompletion: 0,
          originPeer: PEER,
          originProject: OTHER_PROJECT,
          originParent: null,
          originReportTo: MAIN,
          createdAt: 500,
          endedAt: null,
          processId: null,
          turnId: null,
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

  it.effect("process facts: placed, ready keeps its first seq, pid, conversation, ended", () =>
    Effect.gen(function* () {
      const { sql, mainProcess, firstReady, subProcess } = yield* story
      const rows = yield* rowsOf<Record<string, unknown>>(
        sql,
        `SELECT id, harness, provider, model, routing, runtime, terminal, pid, integration_version,
          integration_protocol, conversation, started_at, placed_at, ready_at, ready_seq, ended_at, end_reason
        FROM process ORDER BY id`,
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
        readySeq: firstReady,
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
        readySeq: null,
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
            projectId: P,
            sessionId: SUB,
            data: { role: "subagent", name: "s", directory: "", archiveOnCompletion: false },
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

  it.effect("turn facts: started, reported leaves the read model alone, ended once", () =>
    Effect.gen(function* () {
      const { sql, journal, turn, report, typed, subProcess, mainProcess } = yield* story
      yield* journal.commit(
        journal.emit(Catalog["turn.ended"], { sessionId: SUB, at: 999, data: { turn, status: "lost" } }),
      )
      assert.deepStrictEqual(
        yield* rowsOf(
          sql,
          "SELECT id, session_id, process_id, typed, started_at, status, report_seq, failure, ended_at FROM turn ORDER BY id",
        ),
        [
          {
            id: turn,
            sessionId: SUB,
            processId: subProcess,
            typed: null,
            startedAt: 310,
            status: "completed",
            reportSeq: report,
            failure: null,
            endedAt: 321,
          },
          {
            id: typed,
            sessionId: MAIN,
            processId: mainProcess,
            typed: "hello",
            startedAt: 540,
            status: "failed",
            reportSeq: null,
            failure: "model overloaded",
            endedAt: 541,
          },
        ],
      )
    }).pipe(Effect.provide(memory())),
  )

  it.effect("inbox facts: queued and moved, with the turn that took a row", () =>
    Effect.gen(function* () {
      const { sql, task, turn, result, notice } = yield* story
      const [moved] = yield* sql<{ seq: number }>`SELECT max(seq) AS seq FROM event WHERE type = 'inbox.moved'`
      assert.deepStrictEqual(
        yield* rowsOf(
          sql,
          `SELECT id, recipient_session_id, sender_session_id, kind, content, result_turn_id, request, peer_item,
            status, turn_id, queued_at, seq FROM inbox ORDER BY id`,
        ),
        [
          {
            id: task,
            recipientSessionId: SUB,
            senderSessionId: MAIN,
            kind: "task",
            content: "fix it",
            resultTurnId: null,
            request: "r-1",
            peerItem: null,
            status: "delivered",
            turnId: turn,
            queuedAt: 301,
            seq: task + 3,
          },
          {
            id: result,
            recipientSessionId: MAIN,
            senderSessionId: SUB,
            kind: "result",
            content: "",
            resultTurnId: turn,
            request: null,
            peerItem: null,
            status: "delivered",
            turnId: null,
            queuedAt: 322,
            seq: moved!.seq,
          },
          {
            id: notice,
            recipientSessionId: MAIN,
            senderSessionId: null,
            kind: "notice",
            content: "remote done",
            resultTurnId: null,
            request: null,
            peerItem: ITEM,
            status: "pending",
            turnId: null,
            queuedAt: 530,
            seq: notice,
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
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT * FROM peer"), [
        { id: PEER, name: "mac2", callsMe: "mb2", connectedAt: 170 },
      ])
      const [queued] = yield* sql<{ seq: number }>`SELECT seq FROM event WHERE type = 'outbox.queued' ORDER BY seq DESC`
      assert.deepStrictEqual(yield* rowsOf(sql, "SELECT * FROM outbox"), [
        {
          id: ITEM_2,
          seq: queued!.seq,
          peerId: PEER,
          sessionId: REMOTE,
          kind: "notice",
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
          Effect.andThen(
            journal.emit(Catalog["peer.seen"], { data: { id: PEER, name: "a", callsMe: "b" } }),
            Effect.fail("stop"),
          ),
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

  it.effect("a session fact takes its project from the session; an inbox fact without recipient uses the sender", () =>
    Effect.gen(function* () {
      const { journal, sql } = yield* ledger
      yield* journal.commit(
        Effect.gen(function* () {
          yield* journal.emit(Catalog["project.created"], { projectId: P, data: { repositories: [] } })
          yield* journal.emit(Catalog["session.created"], {
            projectId: P,
            sessionId: MAIN,
            data: { role: "main", name: "main", directory: "", archiveOnCompletion: false },
          })
          yield* journal.emit(Catalog["inbox.queued"], {
            sessionId: MAIN,
            data: { kind: "send", sender: MAIN, content: "hi", status: "pending" },
          })
          const [row] = yield* sql<{ status: string }>`SELECT status FROM inbox`
          assert.strictEqual(row!.status, "pending")
        }),
      )
      assert.deepStrictEqual(
        yield* rowsOf(sql, "SELECT type, project_id, session_id FROM event WHERE session_id IS NOT NULL ORDER BY seq"),
        [
          { type: "session.created", projectId: P, sessionId: MAIN },
          { type: "inbox.queued", projectId: P, sessionId: MAIN },
        ],
      )
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
            projectId: P,
            sessionId: MAIN,
            data: { role: "main", name: "main", directory: "", archiveOnCompletion: false },
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

  it.effect("a fact that takes its project from its session dies when the caller gives one", () =>
    Effect.gen(function* () {
      const { journal, sql } = yield* ledger
      const exit = yield* journal
        .commit(
          Effect.gen(function* () {
            yield* journal.emit(Catalog["project.created"], { projectId: P, data: { repositories: [] } })
            yield* journal.emit(Catalog["session.created"], {
              projectId: P,
              sessionId: MAIN,
              data: { role: "main", name: "main", directory: "", archiveOnCompletion: false },
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

  it.effect("the log refuses updates and never reuses a seq", () =>
    Effect.gen(function* () {
      const { journal, sql } = yield* ledger
      const emitConnected = journal.commit(journal.emit(Catalog["machine.connected"], { data: { name: "mb" } }))
      const first = yield* emitConnected
      const second = yield* emitConnected
      const update = yield* sql`UPDATE event SET at = 0 WHERE seq = ${first}`.pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(update))
      yield* sql`DELETE FROM event WHERE seq = ${second}`
      assert.strictEqual(yield* emitConnected, second + 1)
    }).pipe(Effect.provide(memory())),
  )
})

describe("journal rebuild", () => {
  it.effect("a database whose read model is another version replays to the same state", () =>
    Effect.gen(function* () {
      const { sql } = yield* story
      yield* sql`UPDATE meta SET value = '0' WHERE key = 'projection'`
      yield* sql`CREATE TABLE answer (turn INTEGER PRIMARY KEY)`
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

  it.effect("a log row of a type outside the catalog fails the rebuild, names its seq and changes nothing", () =>
    Effect.gen(function* () {
      const { sql } = yield* story
      const [row] = yield* sql<{ seq: number }>`INSERT INTO event (at, type, project_id, session_id, data)
        VALUES (1, 'session.purged', ${P}, ${SUB}, '{}') RETURNING seq`
      const error = yield* rebuild.pipe(Effect.flip)
      assert.strictEqual(error._tag, "UnknownFact")
      assert.include(error.message, `event ${row!.seq}`)
      const [sessions] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM session`
      assert.strictEqual(sessions!.n, 3)
    }).pipe(Effect.provide(memory())),
  )
})
