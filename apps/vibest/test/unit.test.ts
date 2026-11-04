import { Database } from "bun:sqlite"
import url from "node:url"

// Pure pieces (SPEC §15 Unit tests): sqlite, HarnessAdapter argv, result files and reports, git state.
import { assert, describe, it, layer } from "@effect/vitest"
import {
  type CoordinatorInput,
  Harness,
  type HarnessId,
  HarnessUnavailable,
  hasNewline,
  type LaunchInput,
  preflight,
} from "@vibest/core/harness"
import { BUILTIN as ADAPTERS, layer as builtinHarnesses } from "@vibest/core/harnesses"
import { claudeMenuKey, claudeModels } from "@vibest/core/harnesses/claude"
import { cursorModels } from "@vibest/core/harnesses/cursor"
import { piModels } from "@vibest/core/harnesses/pi"
import { listAllModels, normalizeModels } from "@vibest/core/models"
import { caseFoldedWorktrees, Layout, VibestCommand, safeRepositoryDirectory, shellQuote } from "@vibest/core/paths"
import { envelope, isUsageLimitError, outcome, parseReport } from "@vibest/core/results"
import { Storage, encodeAddress, type SessionRow } from "@vibest/core/storage"
import { privateTmp, UserPlatform } from "@vibest/core/system-prompt"
import { turnEndFrom, turnEndOf } from "@vibest/core/turn-ends"
import { COORDINATOR } from "@vibest/plugin-coordinator"
import { CALLER_ENV } from "@vibest/runtime-herdr/caller"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import * as Launch from "@vibest/vibest/launch"
import * as SqliteStorage from "@vibest/vibest/sqlite-storage"
import { APPLICATION_ID, SCHEMA_VERSION } from "@vibest/vibest/sqlite-storage"
import { entrySystemPrompt } from "@vibest/vibest/system-prompt"
import {
  copyIncluded,
  git,
  gitState,
  mainCheckout,
  normalizeRemote,
  repositoryDirectoryName,
  repositoryKey,
} from "@vibest/vibest/worktree"
import { Cause, ConfigProvider, Effect, Exit, FileSystem, Layer, Path, PlatformError } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { makeRepository, sh, tempDirectory, TURNS } from "./fakes.ts"

const database = (filename: string) => SqliteStorage.layer.pipe(Layer.provide(Platform.sqlite(filename)))

const session = (id: string, patch: Partial<Omit<SessionRow, "scope">> = {}): Omit<SessionRow, "scope"> => ({
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

describe("System prompt directory", () => {
  const refused = <A, E, R>(e: Effect.Effect<A, E, R>) =>
    e.pipe(
      Effect.exit,
      Effect.map((exit) => {
        assert.isTrue(Exit.isFailure(exit))
        assert.match(String(Exit.isFailure(exit) && Cause.pretty(exit.cause)), /not a private directory/)
      }),
    )

  it.effect("under TMPDIR: <TMPDIR>/vibest, made with mode 0700", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmp = yield* tempDirectory("vibest-tmpdir-")
      assert.strictEqual(yield* privateTmp(tmp, "/nowhere"), `${tmp}/vibest`)
      assert.strictEqual((yield* fs.stat(`${tmp}/vibest`)).mode & 0o777, 0o700)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "no TMPDIR: <parent>/vibest-<uid>, made 0700 and used again; a wrong mode, a symlink or another owner is refused",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const user = yield* UserPlatform
        const uid = user.uid!
        const parent = yield* tempDirectory("vibest-fallback-")
        const dir = `${parent}/vibest-${uid}`
        assert.strictEqual(yield* privateTmp("", parent), dir)
        assert.strictEqual((yield* fs.stat(dir)).mode & 0o777, 0o700)
        assert.strictEqual(yield* privateTmp("", parent), dir, "an existing private directory is used again")

        yield* fs.chmod(dir, 0o755)
        yield* refused(privateTmp("", parent))

        yield* fs.remove(dir, { recursive: true })
        const target = `${parent}/elsewhere`
        yield* fs.makeDirectory(target, { mode: 0o700 })
        yield* fs.symlink(target, dir)
        yield* refused(privateTmp("", parent))

        // Owned by someone else: this process is told it is another uid, so the directory it finds is not its own.
        yield* fs.remove(dir)
        yield* refused(privateTmp("", parent).pipe(Effect.provideService(UserPlatform, { ...user, uid: uid + 1 })))
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})

describe("Rules", () => {
  it("the coordinator points at the skills and does not repeat their command manual", () => {
    const rules = entrySystemPrompt({ rules: COORDINATOR.rules, instructions: "", memory: "" })
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
    const rules = entrySystemPrompt({ rules: COORDINATOR.rules, instructions: "", memory: "" })
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
          ["summary", outcome('fix "x" <y>', undefined)],
          ["branch", ""],
        ],
        ["result", "a <b> & c"],
      ),
      '<agent-result>\n<agent-id>a1b2c3d4</agent-id>\n<summary>Agent "fix "x" &lt;y&gt;" finished</summary>\n<result>\na <b> & c\n</result>\n</agent-result>',
    )
    assert.strictEqual(outcome("t", "rate_limit"), 'Agent "t" failed: rate_limit')
    assert.isTrue(isUsageLimitError("rate_limit"))
    assert.isTrue(isUsageLimitError("rate_limit: hit the 5 hour limit"))
    assert.isTrue(isUsageLimitError("You've hit your usage limit"))
    assert.isTrue(isUsageLimitError("too many requests"))
    assert.isFalse(isUsageLimitError("model_not_found"))
    assert.isFalse(isUsageLimitError("model_not_found: usage limit"))
    assert.isFalse(isUsageLimitError("server_error: too many requests"))
    assert.isFalse(isUsageLimitError("aborted"))
    assert.isFalse(isUsageLimitError(undefined))
    assert.strictEqual(outcome("t", undefined), 'Agent "t" finished')
    assert.strictEqual(outcome("t", "boom"), 'Agent "t" failed: boom')
  })
})

describe("Storage", () => {
  /** Each test gets its own in-memory database. */
  const fresh = <A, E>(program: Effect.Effect<A, E, Storage>) => program.pipe(Effect.provide(database(":memory:")))

  it.effect("an empty file gets the schema; a foreign file is refused", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const file = path.join(yield* tempDirectory("vibest-db-"), "vibest.db")
      const withDb = <A, E>(e: Effect.Effect<A, E, Storage>) => e.pipe(Effect.provide(database(file)))
      yield* withDb(
        Effect.gen(function* () {
          const db = yield* Storage
          yield* db.insertSession(session("aaaaaaaa"), "r")
          const coord = yield* db.startOwner("r", "pi", false, place)
          yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "notice", message: "m", details: {} })
          assert.strictEqual(coord.sessionId.length, 8)
          assert.lengthOf(yield* db.ownerPending("r"), 1)
        }),
      )
      assert.lengthOf(
        yield* withDb(
          Effect.gen(function* () {
            return yield* (yield* Storage).ownerPending("r")
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
      assert.include(pretty, `${file} is not this vibest's schema`)
      assert.include(pretty, "move it aside to start empty")
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "one coordinator row per project; a harness switch clears the conversation; reports match id and harness",
    () =>
      Effect.gen(function* () {
        const db = yield* Storage
        const first = yield* db.startOwner("r", "pi", false, place)
        assert.isNull(first.harnessSessionId)
        yield* db.reportOwnerConversation(first.sessionId, "pi", "s1")
        const again = yield* db.startOwner("r", "pi", false, place)
        assert.strictEqual(again.sessionId, first.sessionId)
        assert.strictEqual(again.harnessSessionId, "s1")
        yield* db.reportOwnerConversation(first.sessionId, "cursor", "nested")
        yield* db.reportOwnerConversation("nope0000", "pi", "x")
        assert.strictEqual((yield* db.startOwner("r", "pi", false, place)).harnessSessionId, "s1")
        const renewed = yield* db.startOwner("r", "pi", true, place)
        assert.notStrictEqual(renewed.sessionId, first.sessionId)
        assert.isNull(renewed.harnessSessionId)
        yield* db.reportOwnerConversation(renewed.sessionId, "pi", "s4")
        assert.isNull((yield* db.startOwner("r", "claude", false, place)).harnessSessionId)
        yield* db.reportOwnerConversation(renewed.sessionId, "claude", "c1")
        assert.strictEqual((yield* db.startOwner("r", "pi", false, place)).sessionId, renewed.sessionId)
        assert.isNull((yield* db.startOwner("r", "pi", false, place)).harnessSessionId)
        yield* db.reportOwnerConversation(renewed.sessionId, "pi", "s6")
        yield* db.reportOwnerConversation(renewed.sessionId, "pi", "s7")
        assert.strictEqual((yield* db.startOwner("r", "pi", false, place)).harnessSessionId, "s7")
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
        const deleted = yield* Effect.exit(sql`DELETE FROM project WHERE key = 'r'`)
        assert.isTrue(Exit.isFailure(deleted))
      }).pipe(Effect.provide(SqliteStorage.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:"))))),
  )

  const memory = <A, E>(program: Effect.Effect<A, E, Storage | SqlClient.SqlClient>) =>
    program.pipe(Effect.provide(SqliteStorage.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:")))))

  it.effect(
    "rescheduleSource: the open round's input, the trailing delivered user or parent run, and the parent id",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Storage
          const sql = yield* SqlClient.SqlClient
          const parent = yield* db.startOwner("r", "pi", false, place)
          yield* db.insertSession(session("aaaaaaaa"), "r", undefined, "/w", "do it", parent.sessionId)
          yield* db.beginUserTurn("aaaaaaaa", "typed", { turnPromptedAt: 1 })
          const inbox = (kind: string, senderId: string | null, content: string, status: string) =>
            sql`INSERT INTO inbox (recipient_session_id, kind, sender_session_id, content, status)
          VALUES ('aaaaaaaa', ${kind}, ${senderId}, ${content}, ${status})`
          yield* inbox("send", parent.sessionId, "from parent", "delivered")
          yield* inbox("send", null, "later send", "delivered")
          yield* inbox("notice", parent.sessionId, "a notice", "delivered")
          yield* inbox("send", null, "still pending", "pending")
          assert.deepStrictEqual(yield* db.rescheduleSource("aaaaaaaa"), {
            working: "typed",
            delivered: "later send",
            parentSessionId: parent.sessionId,
          })
          yield* db.updateSession("aaaaaaaa", { turnState: "completed" })
          yield* db.beginUserTurn("aaaaaaaa", "", { turnPromptedAt: 2 })
          assert.strictEqual((yield* db.rescheduleSource("aaaaaaaa")).working, "")
          yield* db.updateSession("aaaaaaaa", { turnState: "completed" })
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
        const db = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const parent = yield* db.startOwner("r", "pi", false, place)
        yield* db.insertSession(session("aaaaaaaa"), "r", undefined, "/w", "do it", parent.sessionId)
        yield* db.updateSession("aaaaaaaa", { turnState: "open", turnPromptedAt: 1 })
        yield* db.updateSession("aaaaaaaa", { turnState: "completed" })
        // The second turn consumed a send; the open third consumed nothing.
        yield* db.updateSession("aaaaaaaa", { turnState: "open", turnPromptedAt: 3 })
        const follow = yield* db.insertSend("aaaaaaaa", "add tests")
        yield* db.setInboxStatus([follow!.id], "delivered")
        yield* db.updateSession("aaaaaaaa", { turnState: "completed" })
        yield* db.updateSession("aaaaaaaa", { turnState: "open", turnPromptedAt: 5 })
        const row = (kind: string, senderId: string | null, content: string, status = "delivered") =>
          sql`INSERT INTO inbox (recipient_session_id, kind, sender_session_id, content, status)
          VALUES ('aaaaaaaa', ${kind}, ${senderId}, ${content}, ${status})`
        yield* row("send", parent.sessionId, "from parent")
        yield* row("send", null, "and docs")
        assert.strictEqual((yield* db.rescheduleSource("aaaaaaaa")).delivered, "and docs")
        yield* row("send", null, "also types")
        assert.deepStrictEqual(yield* db.rescheduleSource("aaaaaaaa"), {
          working: "",
          delivered: "and docs\n\nalso types",
          parentSessionId: parent.sessionId,
        })
        yield* row("send", null, "still pending", "pending")
        yield* row("notice", parent.sessionId, "a notice")
        assert.strictEqual((yield* db.rescheduleSource("aaaaaaaa")).delivered, "and docs\n\nalso types")
      }),
    ),
  )

  it.effect("coordinatorLaunch fresh starts a new main session and ends the old one; without fresh the id stays", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const first = yield* db.startOwner("r", "pi", false, place)
        assert.strictEqual((yield* db.startOwner("r", "claude", false, place)).sessionId, first.sessionId)
        const renewed = yield* db.startOwner("r", "pi", true, place)
        assert.notStrictEqual(renewed.sessionId, first.sessionId)
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
        }>`SELECT entry_session_id AS main FROM project WHERE key = 'r'`
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
        const db = yield* Storage
        const sql = yield* SqlClient.SqlClient
        const parent = yield* db.startOwner("r", "pi", false, place)
        assert.isTrue(yield* db.insertSession(session("aaaaaaaa"), "r", undefined, "/w", undefined, parent.sessionId))
        const [row] = yield* sql<{
          parentSessionId: string | null
        }>`SELECT parent_session_id FROM session WHERE id = 'aaaaaaaa'`
        assert.strictEqual(row!.parentSessionId, parent.sessionId)
      }),
    ),
  )

  it.effect(
    "a turn's input is the rows delivered while it is open, or its task; the next turn with none is empty",
    () =>
      memory(
        Effect.gen(function* () {
          const db = yield* Storage
          const sql = yield* SqlClient.SqlClient
          const round = (id: string) =>
            sql<{
              inboxId: number | null
              input: string
            }>`SELECT inbox_id, input FROM ${sql.literal(TURNS)} m WHERE session_id = ${id} AND status = 'working'`
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
          yield* db.updateSession("bbbbbbbb", { turnState: "open", turnPromptedAt: 3 })
          yield* db.setInboxStatus([sent!.id], "delivered")
          const [sendRound] = yield* round("bbbbbbbb")
          assert.strictEqual(sendRound!.inboxId, sent!.id)
          assert.strictEqual(sendRound!.input, "ping")

          yield* db.insertSession(session("cccccccc"), "r")
          const first = yield* db.insertSend("cccccccc", "add a test")
          const second = yield* db.insertSend("cccccccc", "also update the readme")
          yield* db.updateSession("cccccccc", { turnState: "open", turnPromptedAt: 4 })
          yield* db.setInboxStatus([first!.id, second!.id], "delivered")
          const [merged] = yield* round("cccccccc")
          assert.strictEqual(merged!.inboxId, second!.id)
          assert.strictEqual(merged!.input, "add a test\n\nalso update the readme")
          // The next round takes only what came after the whole merged batch.
          yield* db.updateSession("cccccccc", { turnState: "completed" })
          const third = yield* db.insertSend("cccccccc", "and the docs")
          yield* db.updateSession("cccccccc", { turnState: "open", turnPromptedAt: 6 })
          yield* db.setInboxStatus([third!.id], "delivered")
          const [next] = yield* round("cccccccc")
          assert.strictEqual(next!.inboxId, third!.id)
          assert.strictEqual(next!.input, "and the docs")
        }),
      ),
  )

  it.effect("beginUserTurn is false when a round is already working and leaves that input", () =>
    memory(
      Effect.gen(function* () {
        const db = yield* Storage
        const sql = yield* SqlClient.SqlClient
        yield* db.insertSession(session("aaaaaaaa"), "r")
        assert.isTrue(yield* db.beginUserTurn("aaaaaaaa", "kept", { turnPromptedAt: 1 }))
        assert.isFalse(yield* db.beginUserTurn("aaaaaaaa", "dropped", { turnPromptedAt: 2 }))
        assert.deepStrictEqual(
          yield* sql<{ input: string }>`SELECT input FROM ${sql.literal(TURNS)} m WHERE session_id = 'aaaaaaaa'`,
          [{ input: "kept" }],
        )
      }),
    ),
  )

  it.effect("the limit counts non-stopped rows", () =>
    fresh(
      Effect.gen(function* () {
        const db = yield* Storage
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
        const db = yield* Storage
        const sql = yield* SqlClient.SqlClient
        yield* db.insertSession(session("aaaaaaaa"), "r", undefined, "/w", "do it")
        assert.deepStrictEqual(
          yield* sql`SELECT kind, content, status FROM inbox WHERE recipient_session_id = 'aaaaaaaa'`,
          [{ kind: "task", content: "do it", status: "delivered" }],
        )
        assert.deepStrictEqual(yield* db.pendingInbox("aaaaaaaa"), [])
        assert.strictEqual((yield* db.getSession("aaaaaaaa"))!.turnState, "none")
        assert.isFalse(yield* db.turnTaken("aaaaaaaa"), "no open turn")
        yield* db.updateSession("aaaaaaaa", { status: "working", turnState: "open", turnPromptedAt: 5 })
        // The task delivered into the open turn is the stored proof it was taken up (after a vibestd restart too).
        assert.isTrue(yield* db.turnTaken("aaaaaaaa"))
        assert.strictEqual(
          (yield* sql<{ status: string }>`SELECT status FROM ${sql.literal(TURNS)} m WHERE session_id = 'aaaaaaaa'`)[0]
            ?.status,
          "working",
        )
        assert.deepInclude(yield* db.getSession("aaaaaaaa"), {
          status: "working",
          turnState: "open",
          turnPromptedAt: 5,
        })
        yield* db.finishTurn(
          "aaaaaaaa",
          { status: "completed", output: "the answer", failure: { message: "late" } },
          { turnState: "completed" },
          { sessionId: "aaaaaaaa", kind: "result", message: "<summary>done</summary>", details: { summary: "done" } },
        )
        assert.strictEqual((yield* db.getSession("aaaaaaaa"))!.turnState, "completed")
        const turns = yield* sql<{
          status: string
          output: string
          endedAt: number | null
        }>`SELECT status, output, ended_at FROM ${sql.literal(TURNS)} m WHERE session_id = 'aaaaaaaa'`
        assert.strictEqual(turns.length, 1)
        assert.deepInclude(turns[0], { status: "completed", output: "<summary>done</summary>" })
        // The whole turn.end data, as finishTurn was given it.
        const [end] = yield* sql<{ data: string }>`SELECT data FROM event WHERE type = 'turn.end'`
        assert.deepStrictEqual(JSON.parse(end!.data), {
          status: "completed",
          output: "the answer",
          failure: { message: "late" },
        })
        assert.isNotNull(turns[0]!.endedAt)
        assert.deepInclude((yield* db.latestInbox("aaaaaaaa", "result"))!.details, { summary: "done" })
        yield* db.closeTurn("aaaaaaaa", "interrupted", {})
        assert.strictEqual((yield* db.getSession("aaaaaaaa"))!.turnState, "completed")
        assert.notProperty((yield* sql`SELECT * FROM session WHERE id = 'aaaaaaaa'`)[0], "status")
      }).pipe(Effect.provide(SqliteStorage.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:"))))),
  )

  it.effect("a result goes to the parent while it has not ended, then to the project's current main session", () =>
    Effect.gen(function* () {
      const db = yield* Storage
      const sql = yield* SqlClient.SqlClient
      yield* db.insertSession(session("bbbbbbbb"), "r")
      yield* db.insertSession(session("cccccccc"), "r")
      yield* db.insertSession(session("aaaaaaaa"), "r")
      yield* sql`UPDATE session SET parent_session_id = 'bbbbbbbb', report_to_session_id = 'bbbbbbbb' WHERE id = 'aaaaaaaa'`
      yield* sql`UPDATE project SET entry_session_id = 'cccccccc'`
      const recipient = Effect.flatMap(
        sql<{
          recipient: string
        }>`SELECT recipient_session_id AS recipient FROM inbox WHERE kind = 'result' ORDER BY id DESC LIMIT 1`,
        (rows) => Effect.succeed(rows[0]?.recipient),
      )
      const round = (summary: string) =>
        Effect.gen(function* () {
          yield* db.updateSession("aaaaaaaa", { turnState: "open", turnPromptedAt: 1 })
          yield* db.finishTurn(
            "aaaaaaaa",
            { status: "completed" },
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
    }).pipe(Effect.provide(SqliteStorage.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:"))))),
  )

  it.effect("sessionBriefs: the task is the session's task row; latest is its newest turn", () =>
    Effect.gen(function* () {
      const db = yield* Storage
      const sql = yield* SqlClient.SqlClient
      /** A turn of `id` from `at`; with `end`, its `turn.end` and the result row that reports it. */
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
      yield* db.insertSession(session("bbbbbbbb"), "r")
      yield* db.insertSession(session("aaaaaaaa"), "r", undefined, "/w", "from parent", "bbbbbbbb")
      yield* db.insertSend("aaaaaaaa", "later send")
      yield* turn("aaaaaaaa", 1, { at: 10, status: "completed", result: "<summary>old summary</summary>" })
      yield* turn("aaaaaaaa", 2, { at: 20, status: "failed", output: "new line\nmore" })
      yield* db.insertSession(session("dddddddd"), "r", undefined, "/w", "do it")
      yield* db.insertSession(session("eeeeeeee"), "r")
      yield* db.updateSession("eeeeeeee", { turnState: "open", turnPromptedAt: 5 })
      yield* db.insertSession(session("ffffffff"), "r")
      yield* turn("ffffffff", 3, { at: 7, status: "interrupted", output: "fallback\nrest" })
      yield* db.insertSession(session("11111111"), "r")
      // A result's summary, even empty, wins over the output's first line.
      yield* turn("11111111", 4, { at: 8, status: "lost", output: "hidden", result: "<summary></summary>" })

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
        latest: { status: "lost", summary: "", endedAt: 8 },
      })
      assert.isUndefined(briefs.get("00000000"))
      assert.strictEqual((yield* db.sessionBriefs([])).size, 0)
    }).pipe(Effect.provide(SqliteStorage.layer.pipe(Layer.provideMerge(Platform.sqlite(":memory:"))))),
  )
  it.effect("a result with no coordinator is dropped; a claim takes a pending row once", () =>
    fresh(
      Effect.gen(function* () {
        const db = yield* Storage
        yield* db.insertSession(session("aaaaaaaa", { turnState: "open" }), "r")
        const [dropped] = yield* db.finishTurn(
          "aaaaaaaa",
          { status: "completed" },
          { turnState: "completed", status: "idle" },
          {
            sessionId: "aaaaaaaa",
            kind: "result",
            message: "m",
            details: { status: "completed" },
          },
        )
        assert.strictEqual(dropped!.status, "dropped")
        assert.strictEqual((yield* db.latestInbox("aaaaaaaa", "result"))!.status, "dropped")
        yield* db.startOwner("r", "pi", false, place)
        const row = (yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "report", message: "hi", details: {} }))[0]!
        assert.strictEqual(row.status, "pending")
        const guard = {
          scope: (yield* db.getSession("aaaaaaaa"))!.scope,
          runtime: RUNTIME,
          address: encodeAddress(place.address),
        }
        assert.deepStrictEqual(yield* db.claim([row.id], guard), [row.id])
        assert.deepStrictEqual(yield* db.claim([row.id], guard), [])
        yield* db.setInboxStatus([row.id], "delivered", "sending")
        assert.strictEqual((yield* db.latestInbox("aaaaaaaa", "report"))!.status, "delivered")
        yield* db.insertInbox({ sessionId: "aaaaaaaa", kind: "notice", message: "n", details: {} })
        yield* db.clearOwnerAt(RUNTIME, place.address)
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

  /** Real `Storage` init, but the last schema statement never runs. */
  const brokenInstall = (file: string, how: "fail" | "interrupt") =>
    SqliteStorage.layer.pipe(
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

  it.effect("an empty file initializes atomically, reopens, and allows one coordinator per project", () =>
    Effect.gen(function* () {
      const file = yield* fileAt(yield* tempDirectory("vibest-schema-"), "vibest.db")
      const opened = yield* Effect.gen(function* () {
        const db = yield* Storage
        const sql = yield* SqlClient.SqlClient
        assert.strictEqual((yield* sql<{ journalMode: string }>`PRAGMA journal_mode`)[0]?.journalMode, "wal")
        assert.strictEqual(
          (yield* sql<{ applicationId: number }>`PRAGMA application_id`)[0]?.applicationId,
          APPLICATION_ID,
        )
        yield* db.insertSession(session("aaaaaaaa"), "r")
        const first = yield* db.startOwner("r", "pi", false, place)
        assert.strictEqual((yield* db.startOwner("r", "pi", false, place)).sessionId, first.sessionId)
        return first.sessionId
      }).pipe(Effect.provide(SqliteStorage.layer.pipe(Layer.provideMerge(Platform.sqlite(file)))))
      assert.strictEqual(
        yield* Effect.gen(function* () {
          const db = yield* Storage
          assert.strictEqual((yield* db.getSession("aaaaaaaa"))?.id, "aaaaaaaa")
          return (yield* db.ownerOf("r"))?.id
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
          const db = yield* Storage
          assert.isTrue(yield* db.insertSession(session("aaaaaaaa"), "r"))
          assert.strictEqual((yield* db.startOwner("r", "pi", false, place)).sessionId.length, 8)
        }).pipe(Effect.provide(database(file)))
        assert.strictEqual((yield* header(file)).applicationId, APPLICATION_ID)
        assert.strictEqual((yield* header(file)).userVersion, SCHEMA_VERSION)
      }
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("an incomplete v2 is rejected and left byte-identical", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* tempDirectory("vibest-schema-partial-")
      const pragma = [`PRAGMA application_id = ${APPLICATION_ID}`, `PRAGMA user_version = ${SCHEMA_VERSION}`]
      const tables = [
        "CREATE TABLE project (id INTEGER PRIMARY KEY) STRICT",
        "CREATE TABLE session (id TEXT PRIMARY KEY, project_id INTEGER, parent_session_id TEXT, machine TEXT, directory TEXT) STRICT",
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
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("a version 1 vibest database is refused, naming its path and the release's migration script", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const file = yield* fileAt(yield* tempDirectory("vibest-schema-v1-"), "vibest.db")
      yield* writeSql(file, [
        `PRAGMA application_id = ${APPLICATION_ID}`,
        "PRAGMA user_version = 1",
        "CREATE TABLE project (id INTEGER)",
      ])
      const before = yield* fs.readFile(file)
      const pretty = yield* refusal(file)
      assert.include(pretty, `${file} is from an older vibest`)
      assert.include(pretty, "migration script given with this release")
      assert.include(pretty, "move it aside to start empty")
      assert.notInclude(pretty, "scripts/migrate")
      assert.deepStrictEqual(yield* fs.readFile(file), before)
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
      assert.include(pretty, `${file} is not this vibest's schema`)
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
      const storeModule = url.fileURLToPath(new URL("../../../packages/vibest/src/sqlite-storage.ts", import.meta.url))
      const platformModule = url.fileURLToPath(new URL("../../../packages/server/src/platform/bun.ts", import.meta.url))
      yield* fs.writeFileString(
        script,
        [
          'import { Effect, Layer } from "effect"',
          `import * as SqliteStorage from ${JSON.stringify(storeModule)}`,
          `import * as Platform from ${JSON.stringify(platformModule)}`,
          "await Effect.runPromise(Effect.void.pipe(Effect.provide(SqliteStorage.layer.pipe(Layer.provide(Platform.sqlite(process.argv[2]!))))))",
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

const launchInput: LaunchInput = {
  worktree: "/h/.vibest/worktrees/abcd1234",
  scratch: "/h/.vibest/projects/k/scratch/cli",
  systemPromptFile: "/tmp/vibest/abcd1234/system-prompt.md",
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
    for (const id of ["pi", "claude", "cursor"] as const)
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
      systemPromptFile: "/r.md",
      provider: null,
      model: null,
      sessionId: null,
      pluginDir: dir,
      env: {},
    }
    assert.strictEqual(after(ADAPTERS.claude.coordinatorArgs!(coordinator), "--plugin-dir"), dir)
    assert.strictEqual(after(ADAPTERS.pi.coordinatorArgs!(coordinator), "-e"), `${dir}/extension.mjs`)
  })

  it("cursor's decode: its hooks as neutral events, its preToolUse as a tool call", () => {
    const decode = ADAPTERS.cursor.decode!
    const conversation = { type: "conversation", conversation: "c-1" } as const
    assert.deepStrictEqual(decode("afterAgentResponse", { conversation_id: "c-1", text: "done" }), [
      conversation,
      { type: "turn.end", outcome: "completed", text: "done" },
    ])
    assert.deepStrictEqual(decode("stop", { status: "completed" }), [])
    assert.deepStrictEqual(decode("stop", { status: "error" }), [
      { type: "turn.end", outcome: "failed", failure: { kind: "other", message: "the turn ended with status error" } },
    ])
    assert.deepStrictEqual(decode("beforeSubmitPrompt", { prompt: "look here" }), [
      { type: "turn.start", origin: "typed", text: "look here" },
    ])
    assert.deepStrictEqual(decode("beforeSubmitPrompt", { prompt: "  " }), [])
    // An id that reads as a flag is no conversation.
    assert.deepStrictEqual(decode("afterAgentResponse", { conversation_id: "-x", text: "" }), [
      { type: "turn.end", outcome: "completed", text: "" },
    ])
    assert.deepStrictEqual(
      decode("preToolUse", { tool_name: "Shell", tool_input: { command: "ls", cwd: "sub" }, cwd: "/w" }),
      { tool: { kind: "shell", name: "Shell", command: "ls", paths: [], cwd: "/w/sub" } },
    )
    assert.deepStrictEqual(
      decode("preToolUse", { tool_name: "Read", tool_input: { path: "a" }, cwd: "", workspace_roots: ["/r"] }),
      { tool: { kind: "read", name: "Read", paths: ["a"], cwd: "/r" } },
    )
  })

  it("claude starts with no --settings: its deny rules are the plugin's tool guard (guard.test)", () => {
    assert.notInclude(ADAPTERS.claude.launchArgs(input), "--settings")
  })

  it("Coordinator argv: rules and the inspection tools, no MCP server at all; cursor cannot be one", () => {
    const input: CoordinatorInput = {
      root: "/repo",
      systemPromptFile: "/tmp/vibest/c0ffee00/system-prompt.md",
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
      input.systemPromptFile,
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
    for (const id of ["pi", "claude"] as const)
      assert.notInclude(ADAPTERS[id].coordinatorArgs!(input).join(" "), "session")
    for (const id of ["pi", "claude", "cursor"] as const)
      if (ADAPTERS[id].coordinatorArgs) assert.isFalse(hasNewline(ADAPTERS[id].coordinatorArgs!(input)))
  })

  it("Sessions get no vibest MCP server: claude may run vibest report", () => {
    for (const id of ["pi", "claude", "cursor"] as const)
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

  it.effect("turn ends: a payload's text and error; a neutral turn.end's outcome", () =>
    Effect.sync(() => {
      assert.deepInclude(turnEndFrom("claude", { text: "hi" }, 5), {
        harness: "claude",
        at: 5,
        text: "hi",
        error: undefined,
        interrupted: false,
      })
      assert.deepInclude(turnEndFrom("pi", { text: "", error: "boom", error_details: "why" }, 1), {
        error: "boom: why",
      })
      assert.deepInclude(turnEndOf("claude", { type: "turn.end", outcome: "completed", text: "done" }, 1), {
        text: "done",
        error: undefined,
      })
      assert.deepInclude(turnEndOf("pi", { type: "turn.end", outcome: "interrupted" }, 1), { interrupted: true })
      assert.match(
        turnEndOf("pi", { type: "turn.end", outcome: "failed", failure: { kind: "limited", message: "slow" } }, 1)
          .error!,
        /^rate_limit: slow/,
      )
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
      // VIBEST_PROJECT_KEY overrides it (VIBEST_PROJECT_ID is the numeric project id, not this).
      const overridden = yield* repositoryKey(repo).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { VIBEST_PROJECT_KEY: "my/key" } }))),
      )
      assert.strictEqual(overridden, "my/key")
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
        const tmp = yield* tempDirectory("vibest-tmp-")
        // What vibestd answers the main agent's start with (Project.CoordinatorSession); the CLI writes the system prompt.
        const entry = {
          agent: COORDINATOR.name,
          skills: COORDINATOR.skills,
          systemPrompt: entrySystemPrompt({ rules: COORDINATOR.rules, instructions: "", memory: "" }),
        }
        const run = (
          h: "claude" | "pi" | "cursor",
          harnessSessionId: string | null = null,
          sessionId = "",
          session: Effect.Effect<{
            sessionId: string
            harnessSessionId: string | null
            projectId?: number
            runtime?: string
          }> = Effect.succeed({ sessionId, harnessSessionId }),
        ) =>
          Launch.coordinatorCommand({
            harness: h,
            root: repo,
            provider: null,
            model: null,
            passEnv: CALLER_ENV,
            session: Effect.map(session, (s) => ({ ...s, ...entry })),
          }).pipe(
            Effect.provide(harness),
            Effect.provide(
              ConfigProvider.layerAdd(
                ConfigProvider.fromUnknown({
                  CLAUDE_CONFIG_DIR: claudeDir,
                  TMPDIR: tmp,
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
          VIBEST_SKILLS: "delegate,pipeline",
          VIBEST_HARNESS: "claude",
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
        // The project id and the runtime, when vibestd says them.
        const placed = yield* run(
          "claude",
          null,
          "abcd1234",
          Effect.succeed({
            sessionId: "abcd1234",
            harnessSessionId: null,
            projectId: 7,
            runtime: '{"runtime":"herdr"}',
          }),
        )
        assert.strictEqual(placed.env.VIBEST_PROJECT_ID, "7")
        assert.strictEqual(placed.env.VIBEST_RUNTIME, '{"runtime":"herdr"}')
        // `--resume` only once Claude has written the session; otherwise a new conversation, its id Claude's to choose
        // (the plugin reports it on every request).
        const unwritten = yield* run("claude", "s1", "abcd1234")
        assert.notInclude(unwritten.args, "--resume")
        assert.notInclude(unwritten.args, "--session-id")
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

  it("summary is the first non-empty line cut to about 120 characters; the Remember section is still picked up", () => {
    const r = parseReport("\n  \nFixed it. Tests pass.\nmore\n\n## Remember\nuse bun\n\n## Other\nx")
    assert.deepStrictEqual(r, { summary: "Fixed it. Tests pass.", remember: "use bun" })
    assert.deepStrictEqual(parseReport(""), { summary: undefined, remember: undefined })
    const long = parseReport("x".repeat(200)).summary!
    assert.strictEqual(long.length, 120)
    assert.isTrue(long.endsWith("…"))
    // A status line is no longer parsed: it is just the first line.
    assert.strictEqual(parseReport("status: needs_input\nwhich one?").summary, "status: needs_input")
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
