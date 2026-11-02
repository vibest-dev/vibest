import { Database } from "bun:sqlite"
import url from "node:url"

// Pure pieces (SPEC §15 Unit tests): sqlite, HarnessAdapter argv, result files and reports, git state.
import { assert, describe, it, layer } from "@effect/vitest"
import { APPLICATION_ID, Db, encodeAddress, SCHEMA_VERSION, type SessionRow } from "@vibest/core/db"
import {
  type CoordinatorInput,
  Harness,
  type HarnessId,
  HarnessUnavailable,
  HARNESS_IDS,
  hasNewline,
  type LaunchInput,
  preflight,
} from "@vibest/core/harness"
import { BUILTIN as ADAPTERS, layer as builtinHarnesses } from "@vibest/core/harnesses"
import { claudeMenuKey, claudeModels } from "@vibest/core/harnesses/claude"
import { cursorModels } from "@vibest/core/harnesses/cursor"
import { piModels } from "@vibest/core/harnesses/pi"
import * as Launch from "@vibest/core/launch"
import { listAllModels, normalizeModels } from "@vibest/core/models"
import {
  allocationLeafTaken,
  caseFoldedWorktrees,
  Layout,
  VibestCommand,
  resolveWorktree,
  safeRepositoryDirectory,
  sameWorktreeBucket,
  shellQuote,
  worktreePath,
} from "@vibest/core/paths"
import { envelope, isUsageLimitError, outcome, parseReport, readResult } from "@vibest/core/results"
import { coordinatorRules } from "@vibest/core/rules"
import {
  copyIncluded,
  git,
  gitState,
  mainCheckout,
  normalizeRemote,
  repositoryDirectoryName,
  repositoryKey,
} from "@vibest/core/worktree"
import { CALLER_ENV } from "@vibest/runtime-herdr/caller"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Cause, ConfigProvider, Effect, Exit, FileSystem, Layer, Option, Path, PlatformError, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { encodeJson, makeRepository, sh, tempDirectory } from "./fakes.ts"

const database = (filename: string) => Db.layer.pipe(Layer.provide(Platform.sqlite(filename)))

const session = (id: string, patch: Partial<Omit<SessionRow, "projectId">> = {}): Omit<SessionRow, "projectId"> => ({
  id,
  agent: "general",
  name: "n",
  harnessId: "pi",
  provider: null,
  model: null,
  harnessSessionId: null,
  runtime: RUNTIME,
  address: { machine: "local", id: "default" },
  status: "unknown",
  startedAt: null,
  exitedAt: null,
  turnState: "none",
  turnPromptedAt: 0,
  metadata: {},
  createdAt: 1,
  lastActive: 1,
  ...patch,
})
const place = { runtime: RUNTIME, address: { machine: "local", id: "test/p1" } }

describe("Rules", () => {
  it("the coordinator points at the skills and does not repeat their command manual", () => {
    const rules = coordinatorRules({ instructions: "", memory: "" })
    assert.include(rules, "`delegate`")
    assert.include(rules, "`pipeline`")
    assert.notInclude(rules, "--archive-on-completion")
    assert.notInclude(rules, "vibest archive")
    assert.notInclude(rules, "vibest ls")
    assert.notInclude(rules, "--peer")
    assert.notInclude(rules, "--access")
    // No blanket ban, and no broader permission beside it.
    assert.notInclude(rules, "Do not remove sessions on your own")
    assert.notInclude(rules, "no longer needed (interrupt")
  })

  it("the coordinator writes prompts in plain sentences in its own voice, and quotes the user only to pass on an approval", () => {
    const rules = coordinatorRules({ instructions: "", memory: "" })
    assert.include(rules, "in plain, complete sentences with no shorthand only you know")
    assert.include(rules, "a space between every word, identifier and number")
    assert.include(rules, "Include only the constraints that apply to this prompt, each once.")
    assert.include(rules, "Never relay or paraphrase the user")
    assert.include(rules, "the only words of the user a prompt may carry are an approval quote")
    assert.include(rules, "leave the approach to the agent")
    assert.match(
      rules,
      /^You are an AI assistant that orchestrates software engineering tasks across multiple coding agents\.\n/,
    )
  })
})

describe("envelope", () => {
  it("one element per field, empty ones left out, field text escaped and the agent's text kept as is", () => {
    assert.strictEqual(
      envelope(
        "agent-result",
        [
          ["agent-id", "a1b2c3d4"],
          ["summary", outcome('fix "x" <y>', "completed", undefined)],
          ["branch", ""],
        ],
        ["result", "a <b> & c"],
      ),
      '<agent-result>\n<agent-id>a1b2c3d4</agent-id>\n<summary>Agent "fix "x" &lt;y&gt;" finished</summary>\n<result>\na <b> & c\n</result>\n</agent-result>',
    )
    assert.strictEqual(outcome("t", "completed", "rate_limit"), 'Agent "t" failed: rate_limit')
    assert.isTrue(isUsageLimitError("rate_limit"))
    assert.isTrue(isUsageLimitError("rate_limit: hit the 5 hour limit"))
    assert.isTrue(isUsageLimitError("You've hit your usage limit"))
    assert.isTrue(isUsageLimitError("too many requests"))
    assert.isFalse(isUsageLimitError("model_not_found"))
    assert.isFalse(isUsageLimitError("model_not_found: usage limit"))
    assert.isFalse(isUsageLimitError("server_error: too many requests"))
    assert.isFalse(isUsageLimitError("aborted"))
    assert.isFalse(isUsageLimitError(undefined))
    assert.strictEqual(outcome("t", "needs_input", undefined), 'Agent "t" is waiting for an answer')
    assert.strictEqual(outcome("t", "unknown", undefined), 'Agent "t" finished without a status line')
  })
})

describe("Db", () => {
  /** Each test gets its own in-memory database. */
  const fresh = <A, E>(program: Effect.Effect<A, E, Db>) => program.pipe(Effect.provide(database(":memory:")))

  it.effect("an empty file gets v1; a foreign file is refused", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const file = path.join(yield* tempDirectory("vibest-db-"), "vibest.db")
      const withDb = <A, E>(e: Effect.Effect<A, E, Db>) => e.pipe(Effect.provide(database(file)))
      yield* withDb(
        Effect.gen(function* () {
          const db = yield* Db
          yield* db.insertSession(session("aaaaaaaa"), "r")
          const coord = yield* db.coordinatorLaunch("r", "pi", false, place)
          yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "notice", message: "m", details: {} })
          assert.strictEqual(coord.sessionId.length, 8)
          assert.lengthOf(yield* db.coordinatorPending(yield* db.projectId("r")), 1)
        }),
      )
      assert.lengthOf(
        yield* withDb(
          Effect.gen(function* () {
            return yield* (yield* Db).coordinatorPending(yield* (yield* Db).projectId("r"))
          }),
        ),
        1,
      )
      yield* Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe("PRAGMA user_version = 99")
      }).pipe(Effect.provide(Platform.sqlite(file)))
      const exit = yield* Effect.exit(withDb(Effect.void))
      assert.isTrue(Exit.isFailure(exit))
      const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      assert.match(pretty, /SchemaMismatch/)
      assert.match(pretty, /move ~\/\.vibest\/vibest\.db away/)
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "one coordinator row per project; a harness switch clears the conversation; reports match id and harness",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const first = yield* db.coordinatorLaunch("r", "pi", false, place)
        assert.isNull(first.harnessSessionId)
        yield* db.reportCoordinatorSession(first.sessionId, "pi", "s1")
        const again = yield* db.coordinatorLaunch("r", "pi", false, place)
        assert.strictEqual(again.sessionId, first.sessionId)
        assert.strictEqual(again.harnessSessionId, "s1")
        yield* db.reportCoordinatorSession(first.sessionId, "cursor", "nested")
        yield* db.reportCoordinatorSession("nope0000", "pi", "x")
        assert.strictEqual((yield* db.coordinatorLaunch("r", "pi", false, place)).harnessSessionId, "s1")
        const renewed = yield* db.coordinatorLaunch("r", "pi", true, place)
        assert.notStrictEqual(renewed.sessionId, first.sessionId)
        assert.isNull(renewed.harnessSessionId)
        yield* db.reportCoordinatorSession(renewed.sessionId, "pi", "s4")
        assert.isNull((yield* db.coordinatorLaunch("r", "claude", false, place)).harnessSessionId)
        yield* db.reportCoordinatorSession(renewed.sessionId, "claude", "c1")
        assert.strictEqual((yield* db.coordinatorLaunch("r", "pi", false, place)).sessionId, renewed.sessionId)
        assert.isNull((yield* db.coordinatorLaunch("r", "pi", false, place)).harnessSessionId)
        yield* db.reportCoordinatorSession(renewed.sessionId, "pi", "s6")
        yield* db.reportCoordinatorSession(renewed.sessionId, "pi", "s7")
        assert.strictEqual((yield* db.coordinatorLaunch("r", "pi", false, place)).harnessSessionId, "s7")
        const sql = yield* SqlClient.SqlClient
        yield* db.insertSession(
          session("aaaaaaaa", { harnessId: "cursor", startedAt: 1, exitedAt: 1, lastActive: 1 }),
          "r",
        )
        assert.isNull((yield* db.getSession("aaaaaaaa"))!.harnessSessionId)
        yield* db.updateSession("aaaaaaaa", { harnessSessionId: "w1" })
        assert.strictEqual((yield* db.getSession("aaaaaaaa"))!.harnessSessionId, "w1")
        assert.deepStrictEqual(
          (yield* db.listSessions({ stopped: true })).map((w) => w.id),
          [first.sessionId, "aaaaaaaa"],
        )
        assert.deepStrictEqual(yield* db.listSessions(), [])
        const deleted = yield* Effect.exit(sql`DELETE FROM project WHERE directory = 'r'`)
        assert.isTrue(Exit.isFailure(deleted))
      }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:"))))),
  )

  const memory = <A, E>(program: Effect.Effect<A, E, Db | SqlClient.SqlClient>) =>
    program.pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:")))))

  it.effect(
    "rescheduleSource: the open round's input, the trailing delivered user or parent run, and the parent id",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Db
          const sql = yield* SqlClient.SqlClient
          const parent = yield* db.coordinatorLaunch("r", "pi", false, place)
          yield* db.insertSession(session("aaaaaaaa"), "r", undefined, "/w", "do it", parent.sessionId)
          yield* sql`INSERT INTO message (session_id, input, status, metadata, started_at) VALUES ('aaaaaaaa', 'typed', 'working', '{}', 1)`
          const inbox = (senderType: string, senderId: string | null, content: string, deliveryStatus: string) =>
            sql`INSERT INTO inbox (recipient_session_id, sender_type, sender_id, content, delivery_status)
          VALUES ('aaaaaaaa', ${senderType}, ${senderId}, ${content}, ${deliveryStatus})`
          yield* inbox("session", parent.sessionId, "from parent", "delivered")
          yield* inbox("user", null, "later send", "delivered")
          yield* inbox("session", "cccccccc", "from stranger", "delivered")
          yield* inbox("user", null, "still pending", "pending")
          assert.deepStrictEqual(yield* db.rescheduleSource("aaaaaaaa"), {
            working: "typed",
            delivered: "later send",
            parentSessionId: parent.sessionId,
          })
          yield* sql`UPDATE message SET input = '' WHERE session_id = 'aaaaaaaa'`
          assert.strictEqual((yield* db.rescheduleSource("aaaaaaaa")).working, "")
          yield* sql`UPDATE message SET status = 'completed' WHERE session_id = 'aaaaaaaa'`
          assert.deepStrictEqual(yield* db.rescheduleSource("aaaaaaaa"), {
            working: "",
            delivered: "later send",
            parentSessionId: parent.sessionId,
          })
          assert.deepStrictEqual(yield* db.rescheduleSource("00000000"), {
            working: "",
            delivered: "",
            parentSessionId: undefined,
          })
        }),
      ),
  )

  it.effect("rescheduleSource: an empty open round resends the trailing same-sender batch, not an earlier turn", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        const parent = yield* db.coordinatorLaunch("r", "pi", false, place)
        yield* db.insertSession(session("aaaaaaaa"), "r", undefined, "/w", "do it", parent.sessionId)
        const [task] = yield* sql<{
          id: number
        }>`SELECT id FROM inbox WHERE recipient_session_id = 'aaaaaaaa' AND content = 'do it'`
        yield* sql`INSERT INTO inbox (recipient_session_id, sender_type, content, delivery_status) VALUES ('aaaaaaaa', 'user', 'add tests', 'delivered')`
        const [follow] = yield* sql<{
          id: number
        }>`SELECT id FROM inbox WHERE recipient_session_id = 'aaaaaaaa' AND content = 'add tests'`
        yield* sql`INSERT INTO message (session_id, inbox_id, input, status, metadata, started_at, ended_at)
        VALUES ('aaaaaaaa', ${task!.id}, 'do it', 'completed', '{}', 1, 2)`
        yield* sql`INSERT INTO message (session_id, inbox_id, input, status, metadata, started_at, ended_at)
        VALUES ('aaaaaaaa', ${follow!.id}, '', 'completed', '{}', 3, 4)`
        yield* sql`INSERT INTO message (session_id, input, status, metadata, started_at) VALUES ('aaaaaaaa', '', 'working', '{}', 5)`
        const row = (senderType: string, senderId: string | null, content: string, deliveryStatus = "delivered") =>
          sql`INSERT INTO inbox (recipient_session_id, sender_type, sender_id, content, delivery_status)
          VALUES ('aaaaaaaa', ${senderType}, ${senderId}, ${content}, ${deliveryStatus})`
        yield* row("session", parent.sessionId, "from parent")
        yield* row("user", null, "and docs")
        assert.strictEqual((yield* db.rescheduleSource("aaaaaaaa")).delivered, "and docs")
        yield* row("user", null, "also types")
        assert.deepStrictEqual(yield* db.rescheduleSource("aaaaaaaa"), {
          working: "",
          delivered: "and docs\n\nalso types",
          parentSessionId: parent.sessionId,
        })
        yield* row("user", null, "still pending", "pending")
        yield* row("session", "cccccccc", "from stranger")
        assert.strictEqual((yield* db.rescheduleSource("aaaaaaaa")).delivered, "and docs\n\nalso types")
      }),
    ),
  )

  it.effect("coordinatorLaunch fresh starts a new main session and ends the old one; without fresh the id stays", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        const first = yield* db.coordinatorLaunch("r", "pi", false, place)
        assert.strictEqual((yield* db.coordinatorLaunch("r", "claude", false, place)).sessionId, first.sessionId)
        const renewed = yield* db.coordinatorLaunch("r", "pi", true, place)
        assert.notStrictEqual(renewed.sessionId, first.sessionId)
        const [old] = yield* sql<{
          endedAt: number | null
          runtime: string | null
        }>`SELECT ended_at, runtime FROM session WHERE id = ${first.sessionId}`
        assert.isNotNull(old!.endedAt)
        assert.isNull(old!.runtime)
        const [project] = yield* sql<{
          main: string
        }>`SELECT main_session_id AS main FROM project WHERE directory = 'r'`
        assert.strictEqual(project!.main, renewed.sessionId)
        assert.deepStrictEqual(yield* db.listSessions(), [])
        assert.isUndefined(yield* db.getSession(renewed.sessionId))
        const ended = yield* db.getSession(first.sessionId)
        assert.strictEqual(ended?.agent, "main")
        assert.strictEqual(ended?.name, "main")
        assert.strictEqual(ended?.exitedAt, old!.endedAt)
        assert.deepStrictEqual(
          (yield* db.listSessions({ stopped: true })).map((row) => row.id),
          [first.sessionId],
        )
      }),
    ),
  )

  it.effect("insertSession stores parent_session_id", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        const parent = yield* db.coordinatorLaunch("r", "pi", false, place)
        assert.isTrue(yield* db.insertSession(session("aaaaaaaa"), "r", undefined, "/w", undefined, parent.sessionId))
        const [row] = yield* sql<{
          parentSessionId: string | null
        }>`SELECT parent_session_id FROM session WHERE id = 'aaaaaaaa'`
        assert.strictEqual(row!.parentSessionId, parent.sessionId)
      }),
    ),
  )

  it.effect("opening a round takes the newest delivered inbox row; the next round with none is empty", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        const round = (id: string) =>
          sql<{
            inboxId: number | null
            input: string
          }>`SELECT inbox_id, input FROM message WHERE session_id = ${id} AND status = 'working'`
        yield* db.insertSession(session("aaaaaaaa"), "r", undefined, "/w", "do it")
        yield* db.updateSession("aaaaaaaa", { turnState: "open", turnPromptedAt: 5 })
        const [task] = yield* sql<{ id: number }>`SELECT id FROM inbox WHERE recipient_session_id = 'aaaaaaaa'`
        const [opened] = yield* round("aaaaaaaa")
        assert.strictEqual(opened!.inboxId, task!.id)
        assert.strictEqual(opened!.input, "do it")
        yield* db.updateSession("aaaaaaaa", { turnState: "completed" })
        yield* db.updateSession("aaaaaaaa", { turnState: "open", turnPromptedAt: 9 })
        const [again] = yield* round("aaaaaaaa")
        assert.isNull(again!.inboxId)
        assert.strictEqual(again!.input, "")

        yield* db.insertSession(session("bbbbbbbb"), "r")
        const sent = yield* db.insertSend("bbbbbbbb", "ping")
        yield* db.setInboxStatus([sent!.id], "delivered")
        yield* db.updateSession("bbbbbbbb", { turnState: "open", turnPromptedAt: 3 })
        const [sendRound] = yield* round("bbbbbbbb")
        assert.strictEqual(sendRound!.inboxId, sent!.id)
        assert.strictEqual(sendRound!.input, "ping")

        yield* db.insertSession(session("cccccccc"), "r")
        const first = yield* db.insertSend("cccccccc", "add a test")
        const second = yield* db.insertSend("cccccccc", "also update the readme")
        yield* db.setInboxStatus([first!.id, second!.id], "delivered")
        yield* db.updateSession("cccccccc", { turnState: "open", turnPromptedAt: 4 })
        const [merged] = yield* round("cccccccc")
        assert.strictEqual(merged!.inboxId, second!.id)
        assert.strictEqual(merged!.input, "add a test\n\nalso update the readme")
        // The next round takes only what came after the whole merged batch.
        yield* db.updateSession("cccccccc", { turnState: "completed" })
        const third = yield* db.insertSend("cccccccc", "and the docs")
        yield* db.setInboxStatus([third!.id], "delivered")
        yield* db.updateSession("cccccccc", { turnState: "open", turnPromptedAt: 6 })
        const [next] = yield* round("cccccccc")
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
        yield* db.insertSession(session("aaaaaaaa"), "r")
        assert.isTrue(yield* db.beginUserTurn("aaaaaaaa", "kept", { turnPromptedAt: 1 }))
        assert.isFalse(yield* db.beginUserTurn("aaaaaaaa", "dropped", { turnPromptedAt: 2 }))
        assert.deepStrictEqual(yield* sql<{ input: string }>`SELECT input FROM message WHERE session_id = 'aaaaaaaa'`, [
          { input: "kept" },
        ])
      }),
    ),
  )

  it.effect("the limit counts non-stopped rows", () =>
    fresh(
      Effect.gen(function* () {
        const db = yield* Db
        assert.isTrue(yield* db.insertSession(session("aaaaaaaa"), "r", 1))
        assert.isFalse(yield* db.insertSession(session("bbbbbbbb"), "r", 1))
        yield* db.updateSession("aaaaaaaa", { status: "unknown", startedAt: 1, exitedAt: 1 })
        assert.isTrue(yield* db.insertSession(session("bbbbbbbb"), "r", 1))
        assert.deepStrictEqual(
          (yield* db.listSessions()).map((w) => w.id),
          ["bbbbbbbb"],
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
        yield* db.insertSession(session("aaaaaaaa"), "r", undefined, "/w", "do it")
        assert.deepStrictEqual(
          yield* sql`SELECT sender_type, content, delivery_status FROM inbox WHERE recipient_session_id = 'aaaaaaaa'`,
          [{ senderType: "user", content: "do it", deliveryStatus: "delivered" }],
        )
        assert.deepStrictEqual(yield* db.pendingInbox("aaaaaaaa"), [])
        assert.strictEqual((yield* db.getSession("aaaaaaaa"))!.turnState, "none")
        yield* db.updateSession("aaaaaaaa", { status: "working", turnState: "open", turnPromptedAt: 5 })
        assert.strictEqual(
          (yield* sql<{ status: string }>`SELECT status FROM message WHERE session_id = 'aaaaaaaa'`)[0]?.status,
          "working",
        )
        assert.deepInclude(yield* db.getSession("aaaaaaaa"), {
          status: "working",
          turnState: "open",
          turnPromptedAt: 5,
        })
        yield* db.finishTurn(
          "aaaaaaaa",
          { turnState: "completed" },
          { sessionId: "aaaaaaaa", kind: "result", message: "r", details: { summary: "done" } },
        )
        assert.strictEqual((yield* db.getSession("aaaaaaaa"))!.turnState, "completed")
        const turns = yield* sql<{
          status: string
          output: string
          endedAt: number | null
          metadata: string
        }>`SELECT status, output, ended_at, metadata FROM message WHERE session_id = 'aaaaaaaa'`
        assert.strictEqual(turns.length, 1)
        assert.deepInclude(turns[0], { status: "completed", output: "r" })
        assert.deepInclude(JSON.parse(turns[0]!.metadata), { summary: "done" })
        assert.isNotNull(turns[0]!.endedAt)
        assert.deepInclude((yield* db.latestInbox("aaaaaaaa", "result"))!.details, { summary: "done" })
        yield* db.closeTurn("aaaaaaaa", "interrupted", {})
        assert.strictEqual((yield* db.getSession("aaaaaaaa"))!.turnState, "completed")
        assert.notProperty((yield* sql`SELECT * FROM session WHERE id = 'aaaaaaaa'`)[0], "status")
      }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:"))))),
  )

  it.effect("a result goes to the parent while it has not ended, then to the project's current main session", () =>
    Effect.gen(function* () {
      const db = yield* Db
      const sql = yield* SqlClient.SqlClient
      yield* db.insertSession(session("bbbbbbbb"), "r")
      yield* db.insertSession(session("cccccccc"), "r")
      yield* db.insertSession(session("aaaaaaaa"), "r")
      yield* sql`UPDATE session SET parent_session_id = 'bbbbbbbb' WHERE id = 'aaaaaaaa'`
      yield* sql`UPDATE project SET main_session_id = 'cccccccc'`
      const recipient = Effect.flatMap(
        sql<{
          recipient: string
        }>`SELECT recipient_session_id AS recipient FROM inbox WHERE result_message_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
        (rows) => Effect.succeed(rows[0]?.recipient),
      )
      const round = (summary: string) =>
        Effect.gen(function* () {
          yield* db.updateSession("aaaaaaaa", { turnState: "open", turnPromptedAt: 1 })
          yield* db.finishTurn(
            "aaaaaaaa",
            { turnState: "completed" },
            { sessionId: "aaaaaaaa", kind: "result", message: summary, details: { summary } },
          )
        })
      yield* round("one")
      assert.strictEqual(yield* recipient, "bbbbbbbb")
      // `vibest --new` ended the old main conversation.
      yield* sql`UPDATE session SET ended_at = 1 WHERE id = 'bbbbbbbb'`
      yield* round("two")
      assert.strictEqual(yield* recipient, "cccccccc")
    }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:"))))),
  )

  it.effect(
    "sessionBriefs: the task is the first delivered inbox row from the parent or the user; latest is the newest message",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        yield* db.insertSession(session("bbbbbbbb"), "r")
        yield* db.insertSession(session("aaaaaaaa"), "r")
        yield* sql`UPDATE session SET parent_session_id = 'bbbbbbbb' WHERE id = 'aaaaaaaa'`
        const inbox = (senderType: string, senderId: string | null, content: string, deliveryStatus: string) =>
          sql`INSERT INTO inbox (recipient_session_id, sender_type, sender_id, content, delivery_status)
          VALUES ('aaaaaaaa', ${senderType}, ${senderId}, ${content}, ${deliveryStatus})`
        yield* inbox("system", "bbbbbbbb", "from system", "delivered")
        yield* inbox("plugin", "plug", "from plugin", "delivered")
        yield* inbox("session", "cccccccc", "from stranger", "delivered")
        yield* inbox("user", null, "not delivered", "pending")
        yield* inbox("session", "bbbbbbbb", "from parent", "delivered")
        yield* inbox("user", null, "later send", "delivered")
        yield* sql`INSERT INTO message (session_id, input, output, status, metadata, started_at, ended_at)
        VALUES ('aaaaaaaa', '', 'old\nstuff', 'completed', '{"summary":"old summary"}', 1, 10)`
        yield* sql`INSERT INTO message (session_id, input, output, status, metadata, started_at, ended_at)
        VALUES ('aaaaaaaa', '', 'new line\nmore', 'failed', '{"branch":"x"}', 2, 20)`

        yield* db.insertSession(session("dddddddd"), "r", undefined, "/w", "do it")
        yield* db.insertSession(session("eeeeeeee"), "r")
        yield* db.updateSession("eeeeeeee", { turnState: "open", turnPromptedAt: 5 })
        yield* db.insertSession(session("ffffffff"), "r")
        yield* db.insertSession(session("11111111"), "r")
        yield* sql`INSERT INTO message (session_id, input, output, status, metadata, started_at, ended_at)
        VALUES ('ffffffff', '', 'fallback\nrest', 'interrupted', 'not-json', 3, 7)`
        yield* sql`INSERT INTO message (session_id, input, output, status, metadata, started_at, ended_at)
        VALUES ('11111111', '', 'nope\nrest', 'lost', '{"summary":1}', 4, 8)`

        const briefs = yield* db.sessionBriefs(["aaaaaaaa", "dddddddd", "eeeeeeee", "ffffffff", "11111111", "00000000"])
        assert.deepStrictEqual(briefs.get("aaaaaaaa"), {
          task: "from parent",
          latest: { status: "failed", summary: "new line", endedAt: 20 },
        })
        assert.deepStrictEqual(briefs.get("dddddddd"), { task: "do it", latest: null })
        assert.deepStrictEqual(briefs.get("eeeeeeee"), {
          task: null,
          latest: { status: "working", summary: "", endedAt: null },
        })
        assert.deepStrictEqual(briefs.get("ffffffff"), {
          task: null,
          latest: { status: "interrupted", summary: "fallback", endedAt: 7 },
        })
        assert.deepStrictEqual(briefs.get("11111111"), {
          task: null,
          latest: { status: "lost", summary: "nope", endedAt: 8 },
        })
        assert.isUndefined(briefs.get("00000000"))
        assert.strictEqual((yield* db.sessionBriefs([])).size, 0)

        // A string summary, even empty, wins over the output's first line.
        yield* sql`UPDATE message SET metadata = '{"summary":""}', output = 'hidden' WHERE session_id = '11111111'`
        assert.strictEqual((yield* db.sessionBriefs(["11111111"])).get("11111111")?.latest?.summary, "")
      }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:"))))),
  )

  it.effect("a result with no coordinator is dropped; a claim takes a pending row once", () =>
    fresh(
      Effect.gen(function* () {
        const db = yield* Db
        yield* db.insertSession(session("aaaaaaaa", { turnState: "open" }), "r")
        const dropped = yield* db.finishTurn(
          "aaaaaaaa",
          { turnState: "completed", status: "idle" },
          {
            sessionId: "aaaaaaaa",
            kind: "result",
            message: "m",
            details: { status: "completed" },
          },
        )
        assert.strictEqual(dropped.status, "dropped")
        assert.strictEqual((yield* db.latestInbox("aaaaaaaa", "result"))!.status, "dropped")
        yield* db.coordinatorLaunch("r", "pi", false, place)
        const row = yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "report", message: "hi", details: {} })
        assert.strictEqual(row.status, "pending")
        const guard = {
          projectId: (yield* db.getSession("aaaaaaaa"))!.projectId,
          runtime: RUNTIME,
          address: encodeAddress(place.address),
        }
        assert.deepStrictEqual(yield* db.claim([row.id], guard), [row.id])
        assert.deepStrictEqual(yield* db.claim([row.id], guard), [])
        yield* db.setInboxStatus([row.id], "delivered", "sending")
        assert.strictEqual((yield* db.latestInbox("aaaaaaaa", "report"))!.status, "delivered")
        yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "notice", message: "n", details: {} })
        yield* db.clearCoordinator(RUNTIME, place.address)
        assert.strictEqual((yield* db.latestInbox("aaaaaaaa", "notice"))!.status, "dropped")
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

  /** Real `Db` init, but the last schema statement never runs. */
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
                  statement.includes("message_session")
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

  it.effect("an empty file initializes atomically, reopens, and allows one coordinator per project", () =>
    Effect.gen(function* () {
      const file = yield* fileAt(yield* tempDirectory("vibest-schema-"), "vibest.db")
      const opened = yield* Effect.gen(function* () {
        const db = yield* Db
        const sql = yield* SqlClient.SqlClient
        assert.strictEqual((yield* sql<{ journalMode: string }>`PRAGMA journal_mode`)[0]?.journalMode, "wal")
        assert.strictEqual(
          (yield* sql<{ applicationId: number }>`PRAGMA application_id`)[0]?.applicationId,
          APPLICATION_ID,
        )
        yield* db.insertSession(session("aaaaaaaa"), "r")
        const first = yield* db.coordinatorLaunch("r", "pi", false, place)
        assert.strictEqual((yield* db.coordinatorLaunch("r", "pi", false, place)).sessionId, first.sessionId)
        return first.sessionId
      }).pipe(Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(file)))))
      assert.strictEqual(
        yield* Effect.gen(function* () {
          const db = yield* Db
          assert.strictEqual((yield* db.getSession("aaaaaaaa"))?.id, "aaaaaaaa")
          return (yield* db.coordinatorOf(yield* db.projectId("r")))?.id
        }).pipe(Effect.provide(database(file))),
        opened,
      )
    }).pipe(Effect.provide(Platform.services)),
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
          assert.isTrue(yield* db.insertSession(session("aaaaaaaa"), "r"))
          assert.strictEqual((yield* db.coordinatorLaunch("r", "pi", false, place)).sessionId.length, 8)
        }).pipe(Effect.provide(database(file)))
        assert.strictEqual((yield* header(file)).applicationId, APPLICATION_ID)
        assert.strictEqual((yield* header(file)).userVersion, SCHEMA_VERSION)
      }
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("an incomplete v1 is rejected and left byte-identical", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDirectory("vibest-schema-partial-")
      const pragma = [`PRAGMA application_id = ${APPLICATION_ID}`, `PRAGMA user_version = ${SCHEMA_VERSION}`]
      const tables = [
        "CREATE TABLE project (id INTEGER PRIMARY KEY) STRICT",
        "CREATE TABLE session (id TEXT PRIMARY KEY, project_id INTEGER, parent_session_id TEXT) STRICT",
        "CREATE TABLE inbox (id INTEGER PRIMARY KEY) STRICT",
      ]
      const cases = [
        ["missing-table.db", [...pragma, tables[0]!], "missing session"],
        [
          "missing-index.db",
          [
            ...pragma,
            ...tables,
            "CREATE INDEX session_project ON session (project_id)",
            "CREATE INDEX session_parent ON session (parent_session_id)",
          ],
          "missing inbox_pending",
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
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("a foreign database with user_version 1 is refused without changing its bytes", () =>
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
      assert.match(pretty, /move ~\/\.vibest\/vibest\.db away/)
      assert.deepStrictEqual(yield* fs.readFile(file), before)
      assert.isFalse(yield* fs.exists(`${file}-wal`))
      assert.isFalse(yield* fs.exists(`${file}-shm`))
      assert.match(yield* refusal(file), /application_id 0x0, v1/)
      assert.deepStrictEqual(yield* fs.readFile(file), before)
      const reader = new Database(file, { readonly: true })
      assert.strictEqual((reader.query("SELECT note FROM other").get() as { note: string } | null)?.note, "keep-me")
      reader.close()
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("a hot foreign WAL is refused without checkpointing the database or WAL", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDirectory("vibest-schema-hot-")
      const file = yield* fileAt(dir, "hot.db")
      const ready = yield* fileAt(dir, "ready")
      const maker = yield* fileAt(dir, "maker.ts")
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
          // Hold db: Bun's GC closes an unreachable Database, and that close checkpoints and empties the WAL.
          "setInterval(() => db, 1000)",
          "",
        ].join("\n"),
      )
      const proc = Bun.spawn(["bun", maker, file, ready], { stdout: "pipe", stderr: "pipe" })
      yield* Effect.gen(function* () {
        for (let i = 0; i < 50; i++) {
          if (yield* fs.exists(ready)) return
          yield* Effect.promise(() => Bun.sleep(20))
        }
        proc.kill()
        return yield* Effect.die("hot wal helper did not start")
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
      const dbModule = url.fileURLToPath(new URL("../../../packages/core/src/db.ts", import.meta.url))
      const platformModule = url.fileURLToPath(new URL("../src/platform/bun.ts", import.meta.url))
      yield* fs.writeFileString(
        script,
        [
          'import { Effect, Layer } from "effect"',
          `import { Db } from ${JSON.stringify(dbModule)}`,
          `import * as Platform from ${JSON.stringify(platformModule)}`,
          "await Effect.runPromise(Effect.void.pipe(Effect.provide(Db.layer.pipe(Layer.provide(Platform.sqlite(process.argv[2]!))))))",
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

const decodeClaudeSettings = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ permissions: Schema.Struct({ deny: Schema.Array(Schema.String) }) })),
)

const launchInput: LaunchInput = {
  worktree: "/h/.vibest/worktrees/abcd1234",
  scratch: "/h/.vibest/projects/k/scratch/cli",
  rules: 'line one\nline "two"',
  rulesFile: "/h/.vibest/rules/abcd1234.md",
  projectsDir: "/h/.vibest/projects",
  provider: null,
  model: null,
  sessionId: "uuid-1",
  resume: false,
  pluginDir: "/opt/vibest/harnesses/x",
  vibest: ["/usr/bin/bun", "/src/main.ts"],
  env: { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "abcd1234", VIBEST_SCRATCH: "/h/.vibest/projects/k/scratch/cli" },
}

describe("HarnessAdapter", () => {
  const input = launchInput

  it("no launch argument contains a newline", () => {
    for (const id of HARNESS_IDS)
      for (const resume of [false, true]) assert.isFalse(hasNewline(ADAPTERS[id].launchArgs({ ...input, resume })))
  })

  it("provider / model translation", () => {
    const pm = { ...input, provider: "openai", model: "gpt-5" }
    assert.deepStrictEqual(ADAPTERS.pi.launchArgs(pm).slice(-4), ["--provider", "openai", "--model", "gpt-5"])
    assert.deepStrictEqual(ADAPTERS.claude.launchArgs({ ...input, model: "opus" }).slice(-2), ["--model", "opus"])
    assert.isString(ADAPTERS.claude.checkProvider("openai"))
    assert.isUndefined(ADAPTERS.claude.checkProvider("anthropic"))
    assert.isUndefined(ADAPTERS.cursor.checkProvider(null))
  })

  it("resume", () => {
    assert.deepStrictEqual(ADAPTERS.claude.launchArgs({ ...input, resume: true }).slice(0, 2), ["--resume", "uuid-1"])
    assert.deepStrictEqual(ADAPTERS.cursor.launchArgs({ ...input, resume: true, sessionId: "c-1" }).slice(0, 1), [
      "--resume=c-1",
    ])
    // `--resume [chatId]` takes an optional value: an id herdr reports that starts with - stays inside the one argument.
    const odd = ADAPTERS.cursor.launchArgs({ ...input, resume: true, sessionId: "--yolo" })
    assert.strictEqual(odd[0], "--resume=--yolo")
    assert.notInclude(odd, "--yolo")
    assert.deepStrictEqual(ADAPTERS.pi.launchArgs({ ...input, resume: true }), ADAPTERS.pi.launchArgs(input))
  })

  it("each harness starts with vibest's plugin for this session only", () => {
    const after = (args: ReadonlyArray<string>, flag: string) => args[args.indexOf(flag) + 1]
    const dir = "/opt/vibest/harnesses/x"
    assert.strictEqual(after(ADAPTERS.cursor.launchArgs(input), "--plugin-dir"), dir)
    assert.strictEqual(after(ADAPTERS.claude.launchArgs(input), "--plugin-dir"), dir)
    assert.strictEqual(after(ADAPTERS.pi.launchArgs(input), "-e"), `${dir}/extension.mjs`)
    const coordinator = {
      root: "/r",
      rules: "",
      rulesFile: "/r.md",
      provider: null,
      model: null,
      sessionId: null,
      pluginDir: dir,
      env: {},
    }
    assert.strictEqual(after(ADAPTERS.claude.coordinatorArgs!(coordinator), "--plugin-dir"), dir)
    assert.strictEqual(after(ADAPTERS.pi.coordinatorArgs!(coordinator), "-e"), `${dir}/extension.mjs`)
  })

  it("cursor reports its turn ends", () => {
    const turnEnd = ADAPTERS.cursor.turnEnd!
    const reply = { hook_event_name: "afterAgentResponse", text: "done" }
    assert.deepStrictEqual(turnEnd(reply, false), { result: reply })
    assert.isUndefined(turnEnd({ hook_event_name: "stop", status: "completed" }, false))
    assert.deepStrictEqual(turnEnd({ hook_event_name: "stop", status: "aborted" }, false), {
      result: { hook_event_name: "stop", status: "aborted", error: "the turn ended with status aborted" },
    })
    assert.isUndefined(turnEnd(reply, true))
  })

  it("cursor reads a user prompt from beforeSubmitPrompt", () => {
    const userPrompt = ADAPTERS.cursor.userPrompt!
    const event = { hook_event_name: "beforeSubmitPrompt", prompt: "look here" }
    assert.deepStrictEqual(userPrompt(event, false), { text: "look here" })
    assert.isUndefined(userPrompt(event, true))
    assert.isUndefined(userPrompt({ hook_event_name: "beforeSubmitPrompt", prompt: "  " }, false))
    assert.isUndefined(userPrompt({ hook_event_name: "afterAgentResponse", prompt: "look here" }, false))
  })

  it("claude denies the project's entries (not the scratchpads, which its hook guards) and herdr", () => {
    const args = ADAPTERS.claude.launchArgs(input)
    const settings = decodeClaudeSettings(args[args.indexOf("--settings") + 1])
    assert.deepStrictEqual(settings.permissions.deny, [
      "Read(//h/.vibest/projects/**/instructions.md)",
      "Edit(//h/.vibest/projects/**/instructions.md)",
      "Read(//h/.vibest/projects/**/docs/**)",
      "Edit(//h/.vibest/projects/**/docs/**)",
      "Read(//h/.vibest/projects/**/memory/**)",
      "Edit(//h/.vibest/projects/**/memory/**)",
      "Bash(herdr:*)",
    ])
  })

  it("Coordinator argv: rules and the inspection tools, no MCP server at all; cursor cannot be one", () => {
    const input: CoordinatorInput = {
      root: "/repo",
      rules: "be a coordinator",
      rulesFile: "/vibest/coordinator/key.md",
      provider: null,
      model: "m",
      sessionId: null,
      pluginDir: "/opt/vibest/harnesses/x",
      env: { VIBEST_AGENT: "coordinator", HERDR_PANE_ID: "w1:p1" },
    }
    const claude = ADAPTERS.claude.coordinatorArgs!(input)
    assert.deepStrictEqual(
      claude.slice(claude.indexOf("--strict-mcp-config"), claude.indexOf("--strict-mcp-config") + 5),
      ["--strict-mcp-config", "--tools", "Bash,Read,Grep,Glob,Skill", "--allowedTools", "Bash,Read,Grep,Glob,Skill"],
    )
    assert.notInclude(claude, "--mcp-config")
    assert.include(claude, "--append-system-prompt-file")
    assert.deepStrictEqual(ADAPTERS.pi.coordinatorArgs!(input), [
      "--system-prompt",
      input.rulesFile,
      "--tools",
      "read,bash,codemode,grep,find,ls",
      "--no-mcp",
      "-e",
      `${input.pluginDir}/extension.mjs`,
      "--model",
      "m",
    ])
    assert.isUndefined(ADAPTERS.cursor.coordinatorArgs)
    // A saved session reopens; without one each harness starts its own, or Claude a new one under the id vibest chose.
    assert.deepStrictEqual(ADAPTERS.pi.coordinatorArgs!({ ...input, sessionId: "s" }).slice(0, 2), [
      "--session-id",
      "s",
    ])
    assert.deepStrictEqual(ADAPTERS.claude.coordinatorArgs!({ ...input, sessionId: "s" }).slice(0, 2), [
      "--resume",
      "s",
    ])
    assert.deepStrictEqual(ADAPTERS.claude.coordinatorArgs!({ ...input, newSessionId: "n" }).slice(0, 2), [
      "--session-id",
      "n",
    ])
    for (const id of ["pi", "claude"] as const)
      assert.notInclude(ADAPTERS[id].coordinatorArgs!(input).join(" "), "session")
    for (const id of HARNESS_IDS)
      if (ADAPTERS[id].coordinatorArgs)
        assert.isFalse(hasNewline(ADAPTERS[id].coordinatorArgs!({ ...input, rules: "a\nb" })))
  })

  it("Sessions get no vibest MCP server: claude may run vibest report", () => {
    for (const id of HARNESS_IDS)
      assert.isEmpty(
        ADAPTERS[id].launchArgs(input).filter((a) => /mcp/i.test(a)),
        id,
      )
    const claude = ADAPTERS.claude.launchArgs(input)
    assert.strictEqual(
      claude[claude.indexOf("--allowedTools") + 1],
      "Bash(vibest report:*),Bash(/usr/bin/bun /src/main.ts report:*)",
    )
  })
})

layer(Layer.merge(Platform.services, builtinHarnesses))("on the platform", (it) => {
  it.effect(
    "claude's deny patterns, matched the way Claude documents (gitignore, here git's own matcher), cover every key shape",
    () =>
      Effect.gen(function* () {
        const root = yield* tempDirectory("vibest-deny-")
        yield* sh(root, "init", "-q")
        const projectsDir = `${root}/projects`
        const args = ADAPTERS.claude.launchArgs({ ...launchInput, projectsDir })
        const deny = decodeClaudeSettings(args[args.indexOf("--settings") + 1]).permissions.deny
        // Read(//<root>/projects/...) → /projects/... relative to the repository at <root>.
        const patterns = deny
          .filter((d) => d.startsWith("Read("))
          .map((d) => d.slice("Read(/".length, -1).replace(root, ""))
        yield* (yield* FileSystem.FileSystem).writeFileString(`${root}/.gitignore`, patterns.join("\n") + "\n")
        const denied = (p: string) =>
          git(root, "check-ignore", "-q", "--no-index", p).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
        const key = normalizeRemote("git@github.com:Owner/Repo.git")
        for (const k of [key, "0123456789ab", "gitlab.com/group/sub/repo"]) {
          for (const entry of ["instructions.md", "docs/a.md", "docs/sub/b.md", "memory/c.md"])
            assert.isTrue(yield* denied(`projects/${k}/${entry}`), `${k}/${entry}`)
          assert.isFalse(yield* denied(`projects/${k}/scratch/pane:s/w1:p1/notes.md`), k)
        }
      }),
  )

  it.effect("model listings run in the user's home, not the caller's working directory", () =>
    Effect.gen(function* () {
      const cwds: Array<string | undefined> = []
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          if (command._tag === "StandardCommand") cwds.push(command.options.cwd)
          return Effect.fail(PlatformError.badArgument({ module: "test", method: "spawn" }))
        }),
      )
      yield* Effect.gen(function* () {
        const harness = yield* Harness.make()
        yield* Effect.flip(harness.models("pi", null))
        yield* listAllModels(["claude", "cursor"], null)
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(
          ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ HOME: "/home/someone" }), { asPrimary: true }),
        ),
      )
      assert.notStrictEqual(process.cwd(), "/home/someone")
      assert.deepStrictEqual(cwds, ["/home/someone", "/home/someone", "/home/someone"])
    }),
  )

  it.effect("preflight names model discovery and keeps the native cause", () =>
    Effect.gen(function* () {
      const reported = (cause: string) =>
        preflight("cursor", null, null).pipe(
          Effect.flip,
          Effect.provide(
            Layer.succeed(Harness, {
              available: () => Effect.succeed(true),
              plugin: (id) => Effect.succeed(`/vibest/harnesses/${id}`),
              models: () => Effect.fail(new HarnessUnavailable({ harness: "cursor", message: cause })),
            }),
          ),
          Effect.map((e) => e.message),
        )
      const keychain = "cursor-agent gave no model list: Run `security unlock-keychain` and try again."
      const query = "cursor-agent did not list its models: spawn ENOENT"
      const auth = "cursor-agent gave no model list: Not logged in"
      assert.strictEqual(yield* reported(keychain), `cursor model discovery failed: ${keychain}`)
      assert.strictEqual(yield* reported(query), `cursor model discovery failed: ${query}`)
      assert.strictEqual(yield* reported(auth), `cursor model discovery failed: ${auth}`)
    }),
  )

  it.effect(
    "vibest's plugin for a harness is VIBEST_HARNESSES/<harness>, else harnesses/ beside the binary's directory, and must be there",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* tempDirectory("vibest-harnesses-")
        yield* fs.makeDirectory(path.join(dir, "pi"))
        const plugin = (env: Record<string, string>, id: HarnessId, self: ReadonlyArray<string> = ["vibest"]) =>
          Harness.make().pipe(
            Effect.flatMap((h) => h.plugin(id)),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
            Effect.provideService(VibestCommand, self),
          )
        assert.strictEqual(yield* plugin({ VIBEST_HARNESSES: dir }, "pi"), path.join(dir, "pi"))
        assert.include(
          (yield* Effect.flip(plugin({ VIBEST_HARNESSES: dir }, "claude"))).message,
          `vibest's claude plugin is missing: ${path.join(dir, "claude")}`,
        )
        assert.include((yield* Effect.flip(plugin({}, "pi"))).message, "VIBEST_HARNESSES is not set")
        // The compiled binary alone, laid out as <root>/bin/vibest beside <root>/harnesses: no VIBEST_HARNESSES needed.
        const root = yield* tempDirectory("vibest-root-")
        yield* fs.makeDirectory(path.join(root, "harnesses", "pi"), { recursive: true })
        assert.strictEqual(
          yield* plugin({}, "pi", [path.join(root, "bin", "vibest")]),
          path.join(root, "harnesses", "pi"),
        )
        assert.strictEqual(
          yield* plugin({ VIBEST_HARNESSES: dir }, "pi", [path.join(root, "bin", "vibest")]),
          path.join(dir, "pi"),
        )
      }),
  )

  it.effect("result files: text field per harness; error marks failure; junk is ignored", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* tempDirectory("vibest-res-")
      const read = (name: string, body?: string) =>
        Effect.gen(function* () {
          const file = path.join(dir, name)
          if (body !== undefined) yield* fs.writeFileString(file, body)
          return Option.getOrUndefined(yield* readResult(file))
        })
      assert.deepInclude(
        yield* read("a.json", encodeJson({ harness: "claude", ts: 1, payload: { last_assistant_message: "hi" } })),
        {
          harness: "claude",
          text: "hi",
          error: undefined,
        },
      )
      assert.deepInclude(
        yield* read("b.json", encodeJson({ harness: "pi", ts: 1, payload: { text: "", error: "boom" } })),
        { error: "boom" },
      )
      assert.isUndefined(yield* read("c.json", "{"))
      assert.isUndefined(yield* read("d.json", encodeJson({ agent: "claude", payload: {} })))
      assert.isUndefined(yield* read("missing.json"))
    }),
  )

  it.effect("repository key: origin, else a path hash of the main checkout", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const key = yield* repositoryKey(repo)
      assert.match(key, /^[a-f0-9]{12}$/)
      // A linked worktree is the same project, remote or not.
      const wt = path.join(yield* tempDirectory("vibest-wt-"), "w")
      yield* sh(repo, "worktree", "add", "-q", "--detach", wt)
      assert.strictEqual(yield* repositoryKey(wt), key)
      yield* sh(repo, "remote", "add", "origin", "git@github.com:a/b.git")
      assert.strictEqual(yield* repositoryKey(repo), "github.com/a/b")
      assert.strictEqual(yield* repositoryKey(wt), "github.com/a/b")
      // Another clone of the same remote, over https, is the same project too.
      const clone = path.join(yield* tempDirectory("vibest-clone-"), "c")
      yield* sh(repo, "clone", "-q", repo, clone)
      yield* sh(clone, "remote", "set-url", "origin", "https://github.com/A/b.git")
      assert.strictEqual(yield* repositoryKey(clone), "github.com/a/b")
    }),
  )

  it.effect("repository directory name is the remote's own name, or the main checkout's, not the key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const base = path.basename(repo)
      yield* fs.makeDirectory(path.join(repo, "pkg"))
      assert.strictEqual(yield* repositoryDirectoryName(path.join(repo, "pkg")), base)
      assert.notStrictEqual(base, "pkg")
      yield* sh(repo, "remote", "add", "origin", "git@github.com:Org/MyRepo.git")
      assert.strictEqual(yield* repositoryDirectoryName(path.join(repo, "pkg")), "MyRepo")
      assert.strictEqual(yield* repositoryKey(repo), "github.com/org/myrepo")
      yield* sh(repo, "remote", "set-url", "origin", "https://example.com/Repo.git/")
      assert.strictEqual(yield* repositoryDirectoryName(repo), "Repo")
      assert.isTrue(safeRepositoryDirectory("MyRepo"))
      assert.isTrue(safeRepositoryDirectory("pi-orchestrator"))
      assert.isFalse(safeRepositoryDirectory("abcd1234"))
      assert.strictEqual(safeRepositoryDirectory("ABCD1234"), !caseFoldedWorktrees)
      assert.isFalse(safeRepositoryDirectory(".."))
      assert.isFalse(safeRepositoryDirectory("a/b"))
      assert.isFalse(safeRepositoryDirectory(""))
      const rows = [
        { id: "11111111", metadata: { worktreeRepository: "MyRepo", worktreeName: "abcd" } },
        { id: "22222222", metadata: { peer: "11111111" } },
      ]
      assert.isTrue(allocationLeafTaken(rows, "MyRepo", "abcd"))
      assert.strictEqual(allocationLeafTaken(rows, "myrepo", "abcd"), sameWorktreeBucket("MyRepo", "myrepo"))
      assert.isFalse(allocationLeafTaken(rows, "MyRepo", "abcd", "11111111"))
      assert.isFalse(allocationLeafTaken(rows, "Other", "abcd"))
      assert.isFalse(allocationLeafTaken(rows, "MyRepo", "abce"))
      const layout = {
        legacyWorktree: (id: string) => `/wt/${id}`,
        allocationWorktree: (repository: string, name: string) => `/wt/${repository}/${name}`,
      }
      const owner = { id: "abcd1234", metadata: {} }
      assert.strictEqual(worktreePath(layout, owner), "/wt/abcd1234")
      assert.strictEqual(
        worktreePath(layout, { id: "abcd1234", metadata: { worktreeRepository: "MyRepo", worktreeName: "ab12" } }),
        "/wt/MyRepo/ab12",
      )
      assert.isUndefined(
        worktreePath(layout, { id: "abcd1234", metadata: { worktreeRepository: "../x", worktreeName: "ab12" } }),
      )
      assert.isUndefined(
        worktreePath(layout, { id: "abcd1234", metadata: { worktreeRepository: "a/b", worktreeName: "ab12" } }),
      )
      assert.isUndefined(
        worktreePath(layout, { id: "abcd1234", metadata: { worktreeRepository: "MyRepo", worktreeName: "abcd1234" } }),
      )
      assert.isUndefined(worktreePath(layout, { id: "abcd1234", metadata: { worktreeName: "ab12" } }))
      assert.isUndefined(worktreePath(layout, { id: "../abcd12", metadata: {} }))
      const missing = yield* resolveWorktree(layout, { id: "bbbbbbbb", metadata: { peer: "cccccccc" } }, () =>
        Effect.succeed(undefined),
      )
      assert.strictEqual(missing._tag, "Unresolved")
      const reused = yield* resolveWorktree(layout, { id: "bbbbbbbb", metadata: { peer: "abcd1234" } }, () =>
        Effect.succeed(owner),
      )
      assert.deepStrictEqual(reused, { _tag: "Resolved", path: "/wt/abcd1234", ownerId: "abcd1234" })
    }),
  )

  it.effect(
    "vibest: the main checkout from anywhere inside, linked worktrees included; the main agent's command, env and rules file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const repo = yield* makeRepository
        const home = yield* tempDirectory("vibest-home-")
        assert.strictEqual(yield* mainCheckout(repo), repo)
        yield* fs.makeDirectory(path.join(repo, "sub"))
        assert.strictEqual(yield* mainCheckout(path.join(repo, "sub")), repo)
        const linked = path.join(yield* tempDirectory("vibest-linked-"), "wt")
        yield* sh(repo, "worktree", "add", "-q", "--detach", linked)
        assert.strictEqual(yield* mainCheckout(linked), repo)
        assert.strictEqual((yield* Effect.flip(mainCheckout(home)))._tag, "NotInRepository")

        const harness = Layer.succeed(Harness, {
          available: () => Effect.succeed(true),
          // Every Coordinator needs vibest's plugin (the pre-tool guard); only pi's is missing here.
          plugin: (id) =>
            id === "pi"
              ? Effect.fail(new HarnessUnavailable({ harness: id, message: "vibest's pi plugin is missing: /x/pi" }))
              : Effect.succeed(`/x/${id}`),
          models: () => Effect.succeed([]),
        })
        const claudeDir = yield* tempDirectory("vibest-claude-")
        const recorded: Array<[string, string]> = []
        const record = (sessionId: string, id: string) => Effect.sync(() => void recorded.push([sessionId, id]))
        const run = (
          h: "claude" | "pi" | "cursor",
          harnessSessionId: string | null = null,
          sessionId = "",
          session = Effect.succeed({ sessionId, harnessSessionId }),
        ) =>
          Launch.coordinatorCommand({
            harness: h,
            root: repo,
            provider: null,
            model: null,
            passEnv: CALLER_ENV,
            session,
            record,
          }).pipe(
            Effect.provide(harness),
            Effect.provide(
              ConfigProvider.layerAdd(
                ConfigProvider.fromUnknown({
                  CLAUDE_CONFIG_DIR: claudeDir,
                  HERDR_PANE_ID: "w1:p1",
                  HERDR_SOCKET_PATH: "/h/herdr.sock",
                }),
                { asPrimary: true },
              ),
            ),
            Effect.provide(Layer.effect(Layout, Layout.make(home))),
            Effect.provideService(VibestCommand, ["/bin/vibest"]),
          )
        const claude = yield* run("claude")
        assert.strictEqual(claude.file, "claude")
        // What its shell's `vibest` needs, passed on explicitly for harnesses that filter their shell's environment.
        assert.deepStrictEqual(claude.env, {
          VIBEST_AGENT: "coordinator",
          VIBEST_HOME: home,
          VIBEST_COMMAND: '["/bin/vibest"]',
          VIBEST_SESSION_ID: "",
          HERDR_PANE_ID: "w1:p1",
          HERDR_SOCKET_PATH: "/h/herdr.sock",
        })
        const rules = yield* fs.readFileString(claude.args[claude.args.indexOf("--append-system-prompt-file") + 1]!)
        assert.include(rules, "You are a **coordinator**")
        assert.include(rules, "`delegate`")
        assert.include(rules, "`pipeline`")
        assert.include(rules, "You run the bare command `vibest`")
        assert.notInclude(rules, "`vibest run <harness> -- '<prompt>'`")
        assert.notInclude(rules, "`--peer <id>`")
        assert.notInclude(rules, "/bin/vibest")
        assert.notInclude(rules, "VIBEST_COMMAND")
        assert.notInclude(rules, "mcp__")
        // The coordinator's session id is in the shell's variables too.
        const launched = yield* run("claude", null, "abcd1234")
        assert.strictEqual(launched.env.VIBEST_SESSION_ID, "abcd1234")
        assert.strictEqual(launched.env.VIBEST_SESSION_ID, "abcd1234")
        // `--resume` only once Claude has written the session; otherwise a new one under an id recorded before Claude starts.
        const unwritten = yield* run("claude", "s1", "abcd1234")
        assert.deepStrictEqual(recorded.at(-1)?.[0], "abcd1234")
        assert.notStrictEqual(recorded.at(-1)?.[1], "s1")
        assert.deepStrictEqual(unwritten.args.slice(0, 2), ["--session-id", recorded.at(-1)![1]])
        const transcript = path.join(claudeDir, "projects", repo.replace(/[^a-zA-Z0-9]/g, "-"), "s1.jsonl")
        yield* fs.makeDirectory(path.dirname(transcript), { recursive: true })
        yield* fs.writeFileString(transcript, "{}\n")
        assert.deepStrictEqual((yield* run("claude", "s1", "abcd1234")).args.slice(0, 2), ["--resume", "s1"])
        // A refused launch never asks vibestd for the session, so it does not supersede the running Coordinator's launch.
        let asked = 0
        const counted = Effect.sync(() => (asked++, { sessionId: "abcd1234", harnessSessionId: null }))
        assert.strictEqual((yield* Effect.flip(run("cursor", null, "", counted)))._tag, "HarnessUnavailable")
        assert.include((yield* Effect.flip(run("pi", null, "", counted))).message, "vibest's pi plugin is missing")
        assert.strictEqual(asked, 0)
      }),
  )

  it.effect("git errors carry stderr", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(git(yield* tempDirectory("vibest-nogit-"), "rev-parse", "HEAD"))
      assert.include(error.message, "not a git repository")
    }),
  )

  it.effect("detached worktree: copied files are not dirt; loose commits and edits are not saved; a branch is", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const wt = path.join(yield* tempDirectory("vibest-wt-"), "w")
      yield* sh(repo, "worktree", "add", "-q", "--detach", wt)
      assert.strictEqual(yield* sh(wt, "branch", "--show-current"), "")
      yield* fs.writeFileString(path.join(repo, ".worktreeinclude"), "local.env\n")
      yield* fs.writeFileString(path.join(repo, ".git", "info", "exclude"), "local.env\n", { flag: "a" })
      yield* fs.writeFileString(path.join(repo, "local.env"), "K=1\n")
      assert.deepStrictEqual(yield* copyIncluded(repo, wt), ["local.env"])
      assert.deepStrictEqual(yield* gitState(wt), { branch: "", pushed: false, saved: true, why: "" })

      yield* fs.writeFileString(path.join(wt, "x.txt"), "x")
      assert.strictEqual((yield* gitState(wt))!.why, "uncommitted changes")
      yield* sh(wt, "add", "x.txt")
      yield* sh(wt, "commit", "-q", "-m", "x")
      assert.strictEqual((yield* gitState(wt))!.why, "commits not on any branch")
      yield* sh(wt, "switch", "-q", "-c", "feat/x")
      assert.deepStrictEqual(yield* gitState(wt), { branch: "feat/x", pushed: false, saved: true, why: "" })
      assert.isUndefined(yield* gitState(path.join(wt, "gone")))
    }),
  )

  it.effect("a file is not a git cwd; a symlink to a directory still is", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* makeRepository
      const file = path.join(yield* tempDirectory("vibest-file-"), "leaf")
      yield* fs.writeFileString(file, "x\n")
      assert.isUndefined(yield* gitState(file))
      assert.strictEqual((yield* Effect.flip(mainCheckout(file)))._tag, "NotInRepository")
      const fileLink = path.join(yield* tempDirectory("vibest-flink-"), "f")
      yield* fs.symlink(file, fileLink)
      assert.isUndefined(yield* gitState(fileLink))
      const link = path.join(yield* tempDirectory("vibest-dlink-"), "repo")
      yield* fs.symlink(repo, link)
      assert.strictEqual(yield* mainCheckout(link), yield* mainCheckout(repo))
      assert.ok(yield* gitState(link))
    }),
  )

  /** A worktree of `repo` at a fresh path, detached. */
  const addWorktree = (repo: string) =>
    Effect.gen(function* () {
      const wt = (yield* Path.Path).join(yield* tempDirectory("vibest-wt-"), "w")
      yield* sh(repo, "worktree", "add", "-q", "--detach", wt)
      return wt
    })
  /** Commit `.gitignore` with `ignore`, and write `.worktreeinclude` (untracked) with `include` unless undefined. */
  const policy = (repo: string, ignore: string, include?: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(`${repo}/.gitignore`, ignore)
      yield* sh(repo, "add", ".gitignore")
      yield* sh(repo, "commit", "-q", "-m", "ignore")
      if (include !== undefined) yield* fs.writeFileString(`${repo}/.worktreeinclude`, include)
    })
  const write = (file: string, content: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory((yield* Path.Path).dirname(file), { recursive: true })
      yield* fs.writeFileString(file, content)
    })

  it.effect("copyIncluded: without .worktreeinclude nothing is copied, not even ignored or untracked config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      yield* policy(repo, ".claude/settings.local.json\n.env\n")
      yield* write(`${repo}/.claude/settings.local.json`, "{}\n")
      yield* write(`${repo}/.env`, "K=1\n")
      const exclude = yield* fs.readFileString(`${repo}/.git/info/exclude`)
      const wt = yield* addWorktree(repo)
      assert.deepStrictEqual(yield* copyIncluded(repo, wt), [])
      for (const f of ["CLAUDE.md", ".claude", ".env"]) assert.isFalse(yield* fs.exists(`${wt}/${f}`), f)
      assert.strictEqual(yield* fs.readFileString(`${repo}/.git/info/exclude`), exclude)
    }),
  )

  it.effect(
    "copyIncluded: .worktreeinclude matches that git ignores, by git's own rules; nothing else; repeatable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepository
        yield* write(`${repo}/tracked.txt`, "committed\n")
        yield* sh(repo, "add", "tracked.txt")
        yield* policy(
          repo,
          ".claude/settings.local.json\n.claude/worktrees/\n.env*\ncache/\nlogs/*\nodd*\n",
          "# local config\n.claude/\n.env.local\nCLAUDE.md\ncache/\n!cache/b\nlogs/*\n!logs/keep.log\ntracked.txt\nodd*\n",
        )
        yield* write(`${repo}/tracked.txt`, "edited in the main checkout\n")
        for (const f of [
          ".claude/settings.local.json",
          ".claude/notes.md",
          ".env.local",
          ".env.other",
          "cache/a",
          "cache/b",
          "logs/a.log",
          "logs/keep.log",
          "odd\nname",
          "odd name ",
        ])
          yield* write(`${repo}/${f}`, `${f}\n`)
        // A linked worktree (ignored) and a separate repository (not ignored), each listed by git as one `dir/` entry.
        yield* sh(repo, "worktree", "add", "-q", "--detach", `${repo}/.claude/worktrees/sample`)
        yield* sh(repo, "init", "-q", `${repo}/.claude/nested`)
        yield* write(`${repo}/.claude/nested/f`, "n\n")
        const exclude = yield* fs.readFileString(`${repo}/.git/info/exclude`)

        // git: a file under an excluded directory cannot be re-included, so `!cache/b` does not take it out.
        const selected = [
          ".claude/settings.local.json",
          ".env.local",
          "cache/a",
          "cache/b",
          "logs/a.log",
          "odd\nname",
          "odd name ",
        ]
        const wt = yield* addWorktree(repo)
        assert.sameMembers(yield* copyIncluded(repo, wt), selected)
        for (const f of selected) assert.strictEqual(yield* fs.readFileString(`${wt}/${f}`), `${f}\n`)
        for (const f of [
          "CLAUDE.md",
          ".claude/notes.md",
          ".env.other",
          "logs/keep.log",
          ".claude/worktrees",
          ".claude/nested",
        ])
          assert.isFalse(yield* fs.exists(`${wt}/${f}`), f)
        assert.strictEqual(yield* fs.readFileString(`${wt}/tracked.txt`), "committed\n")
        // Copies are ignored in the worktree, so it is clean, and nothing was written to the shared info/exclude.
        assert.strictEqual(yield* sh(wt, "status", "--porcelain"), "")
        assert.strictEqual(yield* fs.readFileString(`${repo}/.git/info/exclude`), exclude)
        // Again: nothing over what is there; the next worktree gets the same set.
        assert.deepStrictEqual(yield* copyIncluded(repo, wt), [])
        assert.sameMembers(yield* copyIncluded(repo, yield* addWorktree(repo)), selected)
        assert.strictEqual(yield* fs.readFileString(`${repo}/.git/info/exclude`), exclude)
      }),
  )

  it.effect("copyIncluded: only what git ignores both in the main checkout and in the new worktree is copied", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const files = ["committed.env", "shared.dat", "abs.dat", "local.env", "sub/secret.txt", "rel.dat", "inverse.env"]
      yield* policy(repo, "committed.env\ninverse.env\n", files.join("\n") + "\n")
      // Main checkout only: an uncommitted .gitignore edit (adds local.env, drops inverse.env), an untracked nested
      // .gitignore and a relative core.excludesFile, which resolves against each worktree's own root.
      yield* fs.writeFileString(`${repo}/.gitignore`, "committed.env\nlocal.env\n")
      yield* write(`${repo}/sub/.gitignore`, "secret.txt\n")
      yield* write(`${repo}/rel-exclude`, "rel.dat\n")
      yield* sh(repo, "config", "core.excludesFile", "rel-exclude")
      // Shared by every worktree: info/exclude.
      yield* fs.writeFileString(
        `${repo}/.git/info/exclude`,
        (yield* fs.readFileString(`${repo}/.git/info/exclude`)) + "shared.dat\n",
      )
      for (const f of files) yield* write(`${repo}/${f}`, `${f}\n`)
      const wt = yield* addWorktree(repo)
      assert.sameMembers(yield* copyIncluded(repo, wt), ["committed.env", "shared.dat"])
      assert.strictEqual(yield* sh(wt, "status", "--porcelain", "--untracked-files=all"), "")
      // An absolute core.excludesFile (as a global one) applies in both.
      const abs = `${yield* tempDirectory("vibest-excludes-")}/excludes`
      yield* fs.writeFileString(abs, "abs.dat\n")
      yield* sh(repo, "config", "core.excludesFile", abs)
      const wt2 = yield* addWorktree(repo)
      assert.sameMembers(yield* copyIncluded(repo, wt2), ["committed.env", "shared.dat", "abs.dat"])
      assert.strictEqual(yield* sh(wt2, "status", "--porcelain", "--untracked-files=all"), "")
    }),
  )

  it.effect("copyIncluded: a selected symlink is recreated as the same link, never followed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const outside = yield* tempDirectory("vibest-outside-")
      yield* policy(repo, ".claude/\n", ".claude/\n")
      yield* write(`${repo}/.claude/skills/x/SKILL.md`, "skill\n")
      yield* write(`${outside}/out.md`, "outside\n")
      yield* sh(repo, "worktree", "add", "-q", "--detach", `${repo}/.claude/worktrees/sample`)
      const links: Record<string, string> = {
        "out.md": `${outside}/out.md`,
        "dir-link": "skills",
        dangling: "nowhere",
        "wt-link": "worktrees/sample",
        loop: "loop",
      }
      for (const [name, target] of Object.entries(links)) yield* fs.symlink(target, `${repo}/.claude/${name}`)
      const wt = yield* addWorktree(repo)
      assert.sameMembers(yield* copyIncluded(repo, wt), [
        ".claude/skills/x/SKILL.md",
        ...Object.keys(links).map((n) => `.claude/${n}`),
      ])
      for (const [name, target] of Object.entries(links))
        assert.strictEqual(yield* fs.readLink(`${wt}/.claude/${name}`), target, name)
      assert.isFalse(yield* fs.exists(`${wt}/.claude/worktrees`))
    }),
  )

  it.effect("copyIncluded: a path already in the worktree, or under a link there, is left alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const outside = yield* tempDirectory("vibest-outside-")
      yield* policy(repo, "a.json\n.claude/\n", "a.json\n.claude/\n")
      yield* write(`${repo}/a.json`, "main\n")
      yield* write(`${repo}/.claude/settings.local.json`, "{}\n")
      const wt = yield* addWorktree(repo)
      yield* write(`${wt}/a.json`, "the worktree's own\n")
      yield* fs.symlink(outside, `${wt}/.claude`)
      assert.deepStrictEqual(yield* copyIncluded(repo, wt), [])
      assert.strictEqual(yield* fs.readFileString(`${wt}/a.json`), "the worktree's own\n")
      assert.deepStrictEqual(yield* fs.readDirectory(outside), [])
    }),
  )

  it.effect("copyIncluded: a failed check names source, destination and errno, before anything is copied", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      // cfg is a tracked file, a directory in the main checkout only: the worktree's cfg cannot hold cfg/x.
      yield* write(`${repo}/cfg`, "file\n")
      yield* sh(repo, "add", "cfg")
      yield* policy(repo, "a.json\ncfg/\n", "a.json\ncfg/x\n")
      yield* fs.remove(`${repo}/cfg`)
      yield* write(`${repo}/cfg/x`, "x\n")
      yield* write(`${repo}/a.json`, "{}\n")
      const wt = yield* addWorktree(repo)
      const error = yield* Effect.flip(copyIncluded(repo, wt))
      assert.strictEqual(error._tag, "CopyFailed")
      assert.include(error.message, `copy ${repo}/cfg/x -> ${wt}/cfg/x: `)
      assert.match(error.message, /\(ENOTDIR\)$/)
      assert.isFalse(yield* fs.exists(`${wt}/a.json`))
    }),
  )

  it.effect(
    "copyIncluded: a readLink that fails with EACCES or EIO, on the source or on a directory above the destination, fails the copy and writes nothing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepository
        yield* policy(repo, ".claude/\n", ".claude/settings.local.json\n")
        yield* write(`${repo}/.claude/settings.local.json`, "{}\n")
        for (const code of ["EACCES", "EIO"]) {
          for (const at of ["source", "destination parent"] as const) {
            const wt = yield* addWorktree(repo)
            yield* fs.makeDirectory(`${wt}/.claude`)
            const src = `${repo}/.claude/settings.local.json`
            const dst = `${wt}/.claude/settings.local.json`
            const failing = at === "source" ? src : `${wt}/.claude`
            const writes: Array<string> = []
            // The real FileSystem, except readLink of one path fails like the OS would; copy and symlink writes are counted.
            const faulty = Layer.succeed(FileSystem.FileSystem, {
              ...fs,
              readLink: (p: string) =>
                p === failing
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: code === "EACCES" ? "PermissionDenied" : "Unknown",
                        module: "FileSystem",
                        method: "readLink",
                        pathOrDescriptor: p,
                        cause: Object.assign(new Error(code), { code }),
                      }),
                    )
                  : fs.readLink(p),
              copyFile: (from: string, to: string) =>
                Effect.sync(() => writes.push(to)).pipe(Effect.andThen(fs.copyFile(from, to))),
              symlink: (target: string, p: string) =>
                Effect.sync(() => writes.push(p)).pipe(Effect.andThen(fs.symlink(target, p))),
            })
            const error = yield* Effect.flip(copyIncluded(repo, wt).pipe(Effect.provide(faulty)))
            assert.strictEqual(error._tag, "CopyFailed", `${code} ${at}`)
            assert.deepInclude(error, { source: src, destination: dst })
            assert.include(error.message, `copy ${src} -> ${dst}: `)
            assert.include(error.message, `FileSystem.readLink (${failing})`)
            assert.match(error.message, new RegExp(`\\(${code}\\)$`))
            assert.deepStrictEqual(writes, [], `${code} ${at}`)
            assert.isFalse(yield* fs.exists(dst))
          }
        }
      }),
  )
})

describe("pure", () => {
  it("vibest below the root runs again at the root, forwarding --in-parent only when it had it", () => {
    const argv = ["/bin/vibest", "--harness", "pi"]
    assert.deepStrictEqual(Launch.again(argv, "/r", true), ["/bin/vibest", "--harness", "pi", "--in-parent", "/r"])
    assert.deepStrictEqual(Launch.again(argv, "/r", false), argv)
  })

  it.effect("~/.vibest layout: VIBEST_HOME, else $HOME/.vibest; the old product's OMO_HOME is not read", () =>
    Effect.gen(function* () {
      const layout = (env: Record<string, string>) =>
        Effect.gen(function* () {
          return yield* Layout
        }).pipe(
          Effect.provide(Layout.layer),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
          Effect.provide(Platform.services),
        )
      // Negative fixture: OMO_HOME (the pre-rename variable) must not act as a fallback.
      const fallback = yield* layout({ HOME: "/h", OMO_HOME: "/old" })
      assert.deepInclude(fallback, {
        home: "/h/.vibest",
        database: "/h/.vibest/vibest.db",
        socket: "/h/.vibest/vibest.sock",
        config: "/h/.vibest/vibest.json",
      })
      assert.strictEqual((yield* layout({ HOME: "/h", VIBEST_HOME: "/x" })).home, "/x")
    }),
  )

  it("report fields anywhere, markdown emphasis, full-width colon, Remember section", () => {
    const r = parseReport(
      "did things\n\n**Status**： Completed\n_summary_: fixed it\n\n## Remember\nuse bun\n\n## Other\nx",
    )
    assert.deepStrictEqual(r, { status: "completed", summary: "fixed it", remember: "use bun" })
    assert.deepStrictEqual(parseReport("nothing here"), { status: "unknown", summary: undefined, remember: undefined })
    // Cursor's afterAgentResponse joins the turn's messages without a line break.
    assert.strictEqual(
      parseReport("创建 `hello.txt`，建分支并提交。status: completed\nsummary: DONE").status,
      "completed",
    )
    assert.strictEqual(parseReport("Done.Status: failed").status, "failed")
    assert.strictEqual(parseReport("the status: field is described below").status, "unknown")
  })

  it("claude startup menus: Down until the accept option is under ❯, then Enter, once", () => {
    // Claude's trust dialog preselects "No, exit".
    const top = "Do you trust the files in this folder?\n\n ❯ 1. No, exit\n   2. Yes, I trust this folder\n"
    const moved = "Do you trust the files in this folder?\n\n   1. No, exit\n ❯ 2. Yes, I trust this folder\n"
    assert.deepStrictEqual(claudeMenuKey(top, []), { menu: "trust", key: "down" })
    assert.deepStrictEqual(claudeMenuKey(moved, []), { menu: "trust", key: "enter" })
    assert.strictEqual(claudeMenuKey(moved, ["trust"]), undefined)
    assert.strictEqual(claudeMenuKey("❯ ready", []), undefined)
  })

  it("model lists: each harness's own output, its run-without-model choice marked default", () => {
    const j = (v: unknown) => JSON.stringify(v)
    const claudeList = j({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "vibest-models",
        response: {
          models: [
            {
              value: "default",
              resolvedModel: "claude-opus-5-5",
              displayName: "Default (recommended)",
              description: "Opus 5.5",
            },
            { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "complex work" },
            { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "routine" },
          ],
        },
      },
    })
    const claudeApplied = (model: string) =>
      j({
        type: "control_response",
        response: { subtype: "success", request_id: "vibest-settings", response: { applied: { model } } },
      })
    const hook = j({ type: "system", subtype: "hook_started" })
    // settings pick sonnet: the recommendation (opus) is not the default
    assert.deepStrictEqual(claudeModels([hook, claudeList, claudeApplied("claude-sonnet-5-5")]), [
      { model: "opus", name: "Opus 5.5", description: "complex work", default: false },
      { model: "sonnet", name: "Sonnet 5.5", description: "routine", default: true },
    ])
    // a configured model outside the list becomes an entry
    assert.deepStrictEqual(claudeModels([claudeList, claudeApplied("grok-4.6")])?.at(-1), {
      model: "grok-4.6",
      default: true,
    })
    assert.isUndefined(claudeModels([hook, claudeList]))

    const piList = j({
      id: "vibest-models",
      type: "response",
      command: "get_available_models",
      success: true,
      data: {
        models: [
          { provider: "xai", id: "grok-4.3", name: "Grok 4.3", contextWindow: 1000000, maxTokens: 30000, cost: {} },
          { provider: "zai", id: "glm-5.3", name: "GLM 5.3", contextWindow: 272000, maxTokens: 16384 },
        ],
      },
    })
    const piState = j({
      id: "vibest-state",
      type: "response",
      command: "get_state",
      success: true,
      data: { model: { provider: "zai", id: "glm-5.3", name: "GLM 5.3" } },
    })
    assert.deepStrictEqual(piModels([j({ type: "extension_ui_request" }), piState, piList]), [
      {
        provider: "xai",
        model: "grok-4.3",
        name: "Grok 4.3",
        description: "1000000 context, 30000 max output tokens",
        default: false,
      },
      {
        provider: "zai",
        model: "glm-5.3",
        name: "GLM 5.3",
        description: "272000 context, 16384 max output tokens",
        default: true,
      },
    ])
    assert.isUndefined(piModels([piList]))

    const cursor = [
      "Available models",
      "",
      "auto - Auto (default)",
      "composer-2.5 - Composer 2.5 (current)",
      "glm-5.2-max - GLM 5.2 Max",
      "",
      "Tip: use --model <id> (or /model <id> in interactive mode) to switch.",
    ]
    assert.deepStrictEqual(cursorModels(cursor), [
      { model: "auto", name: "Auto", default: false },
      { model: "composer-2.5", name: "Composer 2.5", default: true },
      { model: "glm-5.2-max", name: "GLM 5.2 Max", default: false },
    ])
    assert.isUndefined(cursorModels(["Not logged in"]))
  })

  it("normalizeModels: one Model shape, requested provider filled in, other providers dropped", () => {
    assert.deepStrictEqual(
      normalizeModels("pi", "azure", [
        { model: "gpt-5", description: "older", default: true },
        { model: "gpt-6", name: "GPT-6", default: false },
      ]),
      [
        { harness: "pi", provider: "azure", model: "gpt-5", name: "gpt-5", description: "older", default: true },
        { harness: "pi", provider: "azure", model: "gpt-6", name: "GPT-6", description: "", default: false },
      ],
    )
    const pi = [
      { provider: "xai", model: "grok", default: false },
      { provider: "zai", model: "grok", default: false },
    ]
    assert.deepStrictEqual(
      normalizeModels("pi", null, pi).map((m) => m.provider),
      ["xai", "zai"],
    )
    assert.deepStrictEqual(
      normalizeModels("pi", "zai", pi).map((m) => m.provider),
      ["zai"],
    )
  })

  it("shell quoting", () => {
    assert.strictEqual(shellQuote("/usr/bin/vibest"), "/usr/bin/vibest")
    assert.strictEqual(shellQuote("a b"), "'a b'")
    assert.strictEqual(shellQuote("it's"), "'it'\\''s'")
    assert.strictEqual(shellQuote(""), "''")
  })

  it("remote normalization", () => {
    for (const url of [
      "git@github.com:iamdin/orchestrate-my-agent-cli.git",
      "https://user:token@github.com/iamdin/orchestrate-my-agent-cli.git",
      "ssh://git@github.com/iamdin/orchestrate-my-agent-cli",
      "https://GitHub.com/iamdin/orchestrate-my-agent-cli/",
    ])
      assert.strictEqual(normalizeRemote(url), "github.com/iamdin/orchestrate-my-agent-cli")
  })
})
