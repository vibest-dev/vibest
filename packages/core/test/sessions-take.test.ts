import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { Inbox } from "@vibest/core/inbox"
import { Session } from "@vibest/core/session"
import { Effect, Ref } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { HARNESSES, PULLING_PI } from "./lib/harnesses.ts"
import { until } from "./lib/observe.ts"
import { makeRepository, restartSessions } from "./lib/session.ts"
import { spawnInput, test as plainTest } from "./lib/sessions-helpers.ts"

const test: typeof plainTest = (name, program, options) =>
  plainTest(name, program, { ...options, harnesses: [...HARNESSES, PULLING_PI] })

const entryAsked = Effect.gen(function* () {
  const herdr = yield* FakeRuntime
  const sessions = yield* Session.Service
  const db = yield* Db.Service
  const repo = yield* makeRepository

  const entry = yield* db.session.startRoot(
    yield* projectOf(repo),
    "pulling-pi",
    false,
    {
      runtime: RUNTIME,
      target: { id: "test/coord" },
    },
    { agent: "coordinator" },
  )

  yield* herdr.seedAgent("test/coord")
  const { id } = yield* sessions.spawn(yield* spawnInput(repo))
  yield* until(db.session.getSession(id), (row) => !!row && (row.process?.placedAt ?? null) !== null)
  yield* db.inbox.insertSend(entry.sessionId, "a question", { type: "agent", session: id })

  return { db, sessions, inbox: yield* Inbox.Service, entryId: entry.sessionId, sender: id }
})

const inboxStatuses = (sender: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{
      status: string
    }>`SELECT status FROM inbox WHERE sender_session_id = ${sender} AND sender_type = 'agent'`.pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.status)),
    ),
  )

const acceptedFacts = (session: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{
      n: number
    }>`SELECT COUNT(*) AS n FROM event WHERE type = 'session.execution.started' AND aggregate LIKE ${`%${session}%`}`.pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]!.n),
    ),
  )

describe.concurrent("an idle session takes its next batch", () => {
  test(
    "a take hands the batch once, opens one execution, and takes nothing while it is open",
    Effect.gen(function* () {
      const { db, inbox, entryId } = yield* entryAsked
      const taken = yield* inbox.take(entryId, undefined)
      assert.include(taken!.content, "a question")
      assert.deepStrictEqual(yield* db.session.openExecution(entryId), taken!.execution)

      const statusOf = SqlClient.SqlClient.pipe(
        Effect.flatMap(
          (sql) => sql<{ status: string }>`SELECT status FROM inbox
            WHERE recipient_session_id = ${entryId} AND instr(content, 'a question') > 0`,
        ),
        Effect.map((rows) => rows.map((row) => row.status)),
      )

      assert.deepStrictEqual(yield* statusOf, ["delivering"])
      assert.isUndefined(yield* inbox.take(entryId, undefined))
      assert.isTrue(yield* db.session.acceptExecution(entryId, taken!.execution))
      assert.deepStrictEqual(yield* statusOf, ["delivering"])
    }),
  )

  test(
    "accepting an execution twice changes nothing, and accepting a closed one opens nothing",
    Effect.gen(function* () {
      const { db, inbox, entryId } = yield* entryAsked
      const { execution } = (yield* inbox.take(entryId, undefined))!
      assert.isTrue(yield* db.session.acceptExecution(entryId, execution))
      assert.isTrue(yield* db.session.acceptExecution(entryId, execution))
      assert.strictEqual(yield* acceptedFacts(entryId), 1)
      yield* db.session.closeExecution(entryId, execution, "completed", {})
      assert.isFalse(yield* db.session.acceptExecution(entryId, execution))
      assert.isUndefined(yield* db.session.openExecution(entryId))
    }),
  )

  test(
    "a batch the harness never accepts ends not_started and is not recorded as failed",
    Effect.gen(function* () {
      const { db, sessions, inbox, entryId, sender } = yield* entryAsked
      const { execution } = (yield* inbox.take(entryId, undefined))!
      assert.deepStrictEqual(yield* inboxStatuses(sender), ["delivering"])
      yield* TestClock.adjust("9 seconds")
      yield* sessions.check(entryId)
      yield* until(db.session.getSession(entryId), (row) => row?.openExecution == null)
      assert.deepStrictEqual(yield* inboxStatuses(sender), ["delivering"])
      assert.isUndefined(yield* db.session.openExecution(entryId))
      assert.isFalse(yield* db.session.acceptExecution(entryId, execution))
    }),
  )

  test(
    "a refusal reported again types the batch no second time, also through a rebuilt Session service",
    Effect.gen(function* () {
      const { sessions, inbox, entryId } = yield* entryAsked
      const herdr = yield* FakeRuntime
      const { execution } = (yield* inbox.take(entryId, undefined))!
      yield* sessions.typeTaken(entryId, execution)
      const restarted = yield* restartSessions
      yield* restarted.typeTaken(entryId, execution)
      const typed = yield* herdr.callsTo("send")
      assert.lengthOf(
        typed.filter((c) => c.text?.includes("a question")),
        1,
      )
    }),
  )

  test(
    "a batch an earlier vibestd took is never typed by the fallback, and ends not_started without a failure",
    Effect.gen(function* () {
      const { db, sessions, entryId, sender } = yield* entryAsked
      const herdr = yield* FakeRuntime
      const taken = (yield* db.inbox.takeInbox(entryId, undefined))!
      yield* sessions.typeTaken(entryId, taken.execution)
      const typed = yield* herdr.callsTo("send")
      assert.lengthOf(
        typed.filter((c) => c.text?.includes("a question")),
        0,
      )
      yield* TestClock.adjust("9 seconds")
      yield* sessions.check(entryId)
      yield* until(db.session.getSession(entryId), (row) => row?.openExecution == null)
      assert.deepStrictEqual(yield* inboxStatuses(sender), ["delivering"])
      assert.isUndefined(yield* db.session.openExecution(entryId))
    }),
  )

  test(
    "a batch accepted and closed before the fallback send is not typed, and typing opens no second execution",
    Effect.gen(function* () {
      const { db, sessions, inbox, entryId } = yield* entryAsked
      const herdr = yield* FakeRuntime
      const { execution } = (yield* inbox.take(entryId, undefined))!
      yield* db.session.acceptExecution(entryId, execution)
      yield* db.session.closeExecution(entryId, execution, "completed", {})
      yield* sessions.typeTaken(entryId, execution)
      const typed = yield* herdr.callsTo("send")
      assert.lengthOf(
        typed.filter((c) => c.text?.includes("a question")),
        0,
      )
      assert.isUndefined(yield* db.session.openExecution(entryId))
    }),
  )

  test(
    "typing the refused batch leaves the execution unaccepted until the harness reports it",
    Effect.gen(function* () {
      const { db, sessions, inbox, entryId } = yield* entryAsked
      const { execution } = (yield* inbox.take(entryId, undefined))!
      yield* sessions.typeTaken(entryId, execution)
      assert.isFalse(yield* db.session.executionAccepted(entryId))
      yield* sessions.userPrompt(entryId, "a question")
      assert.isFalse(yield* db.session.executionAccepted(entryId))
      assert.deepStrictEqual(yield* db.session.openExecution(entryId), execution)
      yield* db.session.acceptExecution(entryId, execution)
      assert.isTrue(yield* db.session.executionAccepted(entryId))
    }),
  )

  for (const status of ["working", "blocked", "unknown"] as const) {
    test(
      `a pulled batch the harness never accepted is not accepted by a ${status} runtime state`,
      Effect.gen(function* () {
        const { db, sessions, inbox, entryId, sender } = yield* entryAsked
        const herdr = yield* FakeRuntime
        yield* inbox.take(entryId, undefined)
        yield* herdr.updateAgent("test/coord", (agent) => ({ ...agent, status, seq: agent.seq + 1 }))
        yield* sessions.check(entryId)
        assert.isFalse(yield* db.session.executionAccepted(entryId))
        yield* TestClock.adjust("9 seconds")
        yield* sessions.check(entryId)
        yield* until(db.session.getSession(entryId), (row) => row?.openExecution == null)
        assert.deepStrictEqual(yield* inboxStatuses(sender), ["delivering"])
        assert.isUndefined(yield* db.session.openExecution(entryId))
      }),
    )
  }

  test(
    "only a pulling session takes: a typed session's take is empty and leaves its rows pending, and a pulling session's rows are never typed",
    Effect.gen(function* () {
      const { sessions, inbox, entryId, sender } = yield* entryAsked
      const herdr = yield* FakeRuntime
      yield* sessions.check(entryId)
      yield* TestClock.adjust("1 second")

      const typedToEntry = Effect.map(herdr.callsTo("send"), (calls) =>
        calls.filter((c) => c.terminal === "test/coord" && c.text?.includes("a question")),
      )

      assert.lengthOf(yield* typedToEntry, 0)
      assert.deepStrictEqual(yield* inboxStatuses(sender), ["pending"])
      assert.isDefined(yield* inbox.take(entryId, undefined))
      assert.isUndefined(yield* inbox.take(sender, undefined))
    }),
  )

  test(
    "a remote send taken by the entry names the remote address, not the user",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db.Service
      const inbox = yield* Inbox.Service
      const repo = yield* makeRepository

      const entry = yield* db.session.startRoot(
        yield* projectOf(repo),
        "pulling-pi",
        false,
        { runtime: RUNTIME, target: { id: "test/coord" } },
        { agent: "coordinator" },
      )

      yield* herdr.seedAgent("test/coord")

      assert.strictEqual(
        yield* db.remote.receiveRemoteItem({
          id: "7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f",
          recipient: entry.sessionId,
          kind: "send",
          sender: "aaaaaaaa",
          from: { session: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", agent: "general", title: "Ask me", machine: "mb" },
          content: "report from afar",
        }),
        "queued",
      )
      const taken = yield* inbox.take(entry.sessionId, undefined)
      assert.deepStrictEqual(taken?.detail, [
        {
          sender: {
            type: "agent",
            session: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            agent: "general",
            title: "Ask me",
            machine: "mb",
          },
          message: "report from afar",
        },
      ])
      assert.isTrue(taken?.content.includes("<vibest-agent-message>") === true)
      assert.isTrue(taken?.content.includes("report from afar") === true)
    }),
  )

  test(
    "a working launch-argv execution on a pulling harness is not closed as not_started when a follow-up message arrives",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      const repo = yield* makeRepository
      yield* Ref.set(herdr.onStarted, (session) => db.session.patchLive(session, { ready: 1, pid: 60_000 }))
      const { id } = yield* sessions.spawn(yield* spawnInput(repo, "pulling-pi"))
      yield* until(db.session.getSession(id), (row) => !!row && (row.process?.placedAt ?? null) !== null)
      const first = yield* db.session.openExecution(id)
      assert.isDefined(first)
      assert.isFalse(yield* db.session.executionAccepted(id))
      yield* sessions.send(id, "follow-up while Turn 1 works")
      yield* TestClock.adjust("9 seconds")
      yield* sessions.check(id)
      assert.strictEqual(yield* db.session.openExecution(id), first)
      assert.strictEqual((yield* db.session.getSession(id))?.status, "working")
    }),
  )
})
