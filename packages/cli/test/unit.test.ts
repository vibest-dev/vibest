import { Database } from "bun:sqlite"
import url from "node:url"

import { assert, describe, it, layer } from "@effect/vitest"
import { projectActivity, raisesSeen, unseenDone } from "@vibest/core/activity"
import { Bus } from "@vibest/core/bus"
import { APPLICATION_ID, Db, encodeAddress, SCHEMA_VERSION, type SessionRow } from "@vibest/core/db"
import {
  type CoordinatorInput,
  Harness,
  Harnesses,
  HarnessUnavailable,
  HARNESS_IDS,
  type HarnessId,
  hasNewline,
  type LaunchInput,
  noProvider,
  harnessCatalog,
  harnessOptions,
  preflight,
} from "@vibest/core/harness"
import { BUILTIN as ADAPTERS, layer as builtinHarnesses } from "@vibest/core/harnesses"
import { claudeMenuKey, claudeModels } from "@vibest/core/harnesses/claude"
import { cursorModels } from "@vibest/core/harnesses/cursor"
import { piModels } from "@vibest/core/harnesses/pi"
import * as Launch from "@vibest/core/launch"
import { catalogModels, listModels, normalizeModels } from "@vibest/core/models"
import { caseFoldedWorktrees, Layout, VibestCommand, safeRepositoryDirectory, shellQuote } from "@vibest/core/paths"
import { locateProject, resolveProject } from "@vibest/core/project-identity"
import { envelope, isUsageLimitError, outcome, parseReport, turnEndFrom, turnEndOf } from "@vibest/core/results"
import { privateTmp, UserPlatform } from "@vibest/core/system-prompt"
import { copyIncluded, git, gitState, mainCheckout, repositoryDirectoryName } from "@vibest/core/worktree"
import type { HarnessChoice } from "@vibest/protocol/rpc"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { ID, newId, shortId } from "@vibest/schema/id"
import { Cause, ConfigProvider, Effect, Exit, FileSystem, Layer, Path, PlatformError } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { makeRepository, sh, tempDirectory, TURNS, projectOf } from "./fakes.ts"

const database = (filename: string) => Db.layer.pipe(Layer.provide(Platform.sqlite(filename)), Layer.provide(Bus.layer))

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

describe("ids", () => {
  it.effect("a new id is a UUIDv4; one whose first 8 characters are taken is drawn again", () =>
    Effect.gen(function* () {
      assert.match(yield* newId(), ID)
      const asked: Array<string> = []
      const id = yield* newId((short) => Effect.sync(() => asked.push(short) < 3))
      assert.match(id, ID)
      assert.lengthOf(asked, 3)
      assert.strictEqual(shortId(id), asked[2])
      assert.strictEqual(shortId(id).length, 8)
    }),
  )
})

describe("System prompt directory", () => {
  const refused = <A, E, R>(e: Effect.Effect<A, E, R>) =>
    e.pipe(
      Effect.exit,
      Effect.map((exit) => {
        assert.isTrue(Exit.isFailure(exit))
        assert.match(String(Exit.isFailure(exit) && Cause.pretty(exit.cause)), /not a private directory/)
      }),
    )

  it.effect(
    "under TMPDIR: <TMPDIR>/vibest, made 0700; no TMPDIR: <parent>/vibest-<uid>, made 0700 and used again; a wrong mode, a symlink or another owner is refused",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmp = yield* tempDirectory("vibest-tmpdir-")
        assert.strictEqual(yield* privateTmp(tmp, "/nowhere"), `${tmp}/vibest`)
        assert.strictEqual((yield* fs.stat(`${tmp}/vibest`)).mode & 0o777, 0o700)
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

        yield* fs.remove(dir)
        const asAnotherUid = { ...user, uid: uid + 1 }
        yield* refused(privateTmp("", parent).pipe(Effect.provideService(UserPlatform, asAnotherUid)))
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})

describe("envelope", () => {
  it("one element per field, empty ones left out, field text escaped and the agent's text kept as is", () => {
    assert.strictEqual(
      envelope(
        "agent-result",
        [
          ["agent-id", "a1b2c3d4-a1b2-4a1b-8a1b-a1b2c3d4a1b2"],
          ["summary", outcome('fix "x" <y>', undefined)],
          ["branch", ""],
        ],
        ["result", "a <b> & c"],
      ),
      '<agent-result>\n<agent-id>a1b2c3d4-a1b2-4a1b-8a1b-a1b2c3d4a1b2</agent-id>\n<summary>Agent "fix "x" &lt;y&gt;" finished</summary>\n<result>\na <b> & c\n</result>\n</agent-result>',
    )
    assert.strictEqual(outcome("t", "rate_limit"), 'Agent "t" failed: rate_limit')
    assert.isTrue(isUsageLimitError("rate_limit"))
    assert.isTrue(isUsageLimitError("rate_limit: hit the 5 hour limit"))
    assert.isTrue(isUsageLimitError("You've hit your usage limit"))
    assert.isTrue(isUsageLimitError("too many requests"))
    assert.isFalse(isUsageLimitError("model_not_found"))
    assert.isFalse(isUsageLimitError("model_not_found: usage limit"))
    assert.isFalse(isUsageLimitError("server_error: too many requests"))
    assert.isFalse(isUsageLimitError("server_error: the assistant said rate limit"))
    assert.isFalse(isUsageLimitError("aborted"))
    assert.isFalse(isUsageLimitError(undefined))
    assert.strictEqual(outcome("t", undefined), 'Agent "t" finished')
    assert.strictEqual(outcome("t", "boom"), 'Agent "t" failed: boom')
  })
})

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
          yield* db.insertSession(
            session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            yield* projectOf("r"),
            undefined,
            "/w",
            "do it",
            parent.sessionId,
          )
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

          yield* db.insertSession(
            session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
            yield* projectOf("r"),
            undefined,
            "/w",
            "do it",
            parent.sessionId,
          )
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
          yield* db.insertSession(
            session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            yield* projectOf("r"),
            undefined,
            "/w",
            "do it",
          )
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
          yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), yield* projectOf("r"), 1),
        )
        assert.isFalse(
          yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"), 1),
        )
        yield* db.updateSession("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
          status: "unknown",
          startedAt: 1,
          exitedAt: 1,
        })
        assert.isTrue(
          yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), yield* projectOf("r"), 1),
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
        yield* db.insertSession(
          session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          yield* projectOf("r"),
          undefined,
          "/w",
          "do it",
        )
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
      yield* db.insertSession(
        session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        yield* projectOf("r"),
        undefined,
        "/w",
        "from parent",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      )
      yield* db.insertSend("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "later send")
      yield* turn("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1, {
        at: 10,
        status: "completed",
        result: "<summary>old summary</summary>",
      })
      yield* turn("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 2, { at: 20, status: "failed", output: "new line\nmore" })
      yield* db.insertSession(
        session("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
        yield* projectOf("r"),
        undefined,
        "/w",
        "do it",
      )
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

const launchInput: LaunchInput = {
  worktree: "/h/.vibest/worktrees/abcd1234-abcd-4abc-8abc-abcd1234abcd",
  projectDir: "/h/.vibest/projects/0f5a8b2c-1d3e-4f60-8a7b-9c0d1e2f3a4b",
  systemPromptFile: "/tmp/vibest/abcd1234-abcd-4abc-8abc-abcd1234abcd/system-prompt.md",
  provider: null,
  model: null,
  sessionId: "uuid-1",
  resume: false,
  pluginDir: "/opt/vibest/harnesses/x",
  vibest: ["/usr/bin/bun", "/src/main.ts"],
  env: {
    VIBEST_AGENT: "general",
    VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
    VIBEST_PROJECT_DIR: "/h/.vibest/projects/0f5a8b2c-1d3e-4f60-8a7b-9c0d1e2f3a4b",
  },
}

describe("HarnessAdapter", () => {
  const input = launchInput

  it("cursor resumes a dash-leading session id as one --resume= argument", () => {
    const dashLeadingArgs = ADAPTERS.cursor.launchArgs({
      ...input,
      resume: true,
      sessionId: "--yolo",
    })
    assert.strictEqual(dashLeadingArgs[0], "--resume=--yolo")
    assert.notInclude(dashLeadingArgs, "--yolo")
  })

  it("cursor reports its turn end at its response; its stop hook is not one", () => {
    const turnEnd = ADAPTERS.cursor.turnEnd!
    const reply = { hook_event_name: "afterAgentResponse", text: "done" }
    assert.deepStrictEqual(turnEnd(reply, false), { result: reply })
    for (const status of ["completed", "aborted", "error"])
      assert.isUndefined(turnEnd({ hook_event_name: "stop", status }, false))
    assert.isUndefined(turnEnd(reply, true))
  })

  it("claude reports every reason of the plugin's TurnComplete: answer as it is, aborted, refusal and error failed", () => {
    const turnEnd = ADAPTERS.claude.turnEnd!
    const answer = {
      hook_event_name: "TurnComplete",
      session_id: "c1",
      reason: "answer",
      last_assistant_message: "done",
    }
    assert.deepStrictEqual(turnEnd(answer, false), { result: answer })
    assert.isUndefined(turnEnd(answer, true))
    const aborted = { ...answer, reason: "aborted", last_assistant_message: "" }
    assert.deepStrictEqual(turnEnd(aborted, false), {
      result: {
        ...aborted,
        aborted: true,
        error: "interrupted",
        error_details: "the turn was stopped in its terminal (Esc) before it ended",
      },
    })
    assert.isUndefined(turnEnd(aborted, true))
    const error = { ...answer, reason: "error", last_assistant_message: "" }
    assert.deepStrictEqual(turnEnd(error, false), {
      result: { ...error, error: "error", error_details: "the turn ended on an API error" },
    })
    assert.deepStrictEqual(turnEnd({ ...error, last_assistant_message: " API Error: 500 " }, false), {
      result: {
        ...error,
        last_assistant_message: " API Error: 500 ",
        error: "error",
        error_details: "the turn ended on an API error",
      },
    })
    const refusal = { ...answer, reason: "refusal", refusal: { category: "cyber", explanation: "not that" } }
    assert.deepStrictEqual(turnEnd(refusal, false), {
      result: { ...refusal, error: "refusal", error_details: "cyber: not that" },
    })
    assert.deepStrictEqual(turnEnd({ ...refusal, refusal: { category: null, explanation: null } }, false), {
      result: {
        ...refusal,
        refusal: { category: null, explanation: null },
        error: "refusal",
        error_details: "the model refused to answer",
      },
    })
    for (const name of ["Stop", "StopFailure", "SubagentStop"])
      assert.isUndefined(turnEnd({ ...answer, hook_event_name: name }, false), name)
    assert.isUndefined(turnEnd({ ...answer, session_id: "" }, true))
  })

  it("claude reads a user prompt from the plugin's prompt.submit only when the person submitted it", () => {
    const userPrompt = ADAPTERS.claude.userPrompt!
    const typed = { hook_event_name: "PromptSubmit", text: "look here", origin: "composer" }
    assert.deepStrictEqual(userPrompt(typed, false), { text: "look here" })
    assert.deepStrictEqual(userPrompt({ ...typed, origin: "bridge" }, false), { text: "look here" })
    assert.isUndefined(userPrompt(typed, true))
    assert.isUndefined(userPrompt({ ...typed, text: "  " }, false))
    for (const origin of ["task-notification", "scheduled-trigger", "peer", "plugin", "sdk", "unclassified", undefined])
      assert.isUndefined(userPrompt({ ...typed, origin }, false), String(origin))
    assert.isUndefined(userPrompt({ hook_event_name: "UserPromptSubmit", prompt: "look here", source: "user" }, false))
  })

  it("cursor reads a user prompt from beforeSubmitPrompt, and a thought or tool result as a turn at work", () => {
    const userPrompt = ADAPTERS.cursor.userPrompt!
    const event = { hook_event_name: "beforeSubmitPrompt", prompt: "look here" }
    assert.deepStrictEqual(userPrompt(event, false), { text: "look here" })
    assert.isUndefined(userPrompt(event, true))
    assert.isUndefined(userPrompt({ hook_event_name: "beforeSubmitPrompt", prompt: "  " }, false))
    assert.isUndefined(userPrompt({ hook_event_name: "afterAgentResponse", prompt: "look here" }, false))
    for (const hook_event_name of ["afterAgentThought", "postToolUse"]) {
      assert.deepStrictEqual(userPrompt({ hook_event_name }, false), { text: "" })
      assert.isUndefined(userPrompt({ hook_event_name }, true))
    }
  })

  it("Coordinator argv: rules, the inspection tools and file tools for the project folder, no MCP server at all; cursor cannot be one", () => {
    const input: CoordinatorInput = {
      root: "/repo",
      projectDir: "/h/p",
      systemPromptFile: "/tmp/vibest/c0ffee00-c0ff-4c0f-8c0f-c0ffee00c0ff/system-prompt.md",
      provider: null,
      model: "m",
      sessionId: null,
      pluginDir: "/opt/vibest/harnesses/x",
      env: { VIBEST_AGENT: "coordinator", HERDR_PANE_ID: "w1:p1" },
    }
    const claude = ADAPTERS.claude.coordinatorArgs!(input)
    assert.deepStrictEqual(
      claude.slice(claude.indexOf("--strict-mcp-config"), claude.indexOf("--strict-mcp-config") + 7),
      [
        "--strict-mcp-config",
        "--tools",
        "Bash,Read,Grep,Glob,Skill,Edit,Write",
        "--add-dir",
        "/h/p",
        "--allowedTools",
        "Bash,Read,Grep,Glob,Skill,Read(//h/p/**),Edit(//h/p/**)",
      ],
    )
    assert.notInclude(claude, "--mcp-config")
    assert.include(claude, "--append-system-prompt-file")
    assert.deepStrictEqual(ADAPTERS.pi.coordinatorArgs!(input), [
      "--system-prompt",
      input.systemPromptFile,
      "--tools",
      "read,bash,codemode,grep,find,ls,write,edit",
      "--no-mcp",
      "-e",
      `${input.pluginDir}/extension.mjs`,
      "--model",
      "m",
    ])
    assert.isUndefined(ADAPTERS.cursor.coordinatorArgs)
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
    for (const id of HARNESS_IDS)
      if (ADAPTERS[id].coordinatorArgs) assert.isFalse(hasNewline(ADAPTERS[id].coordinatorArgs!(input)))
  })

  it("Sessions get no vibest MCP server: claude may run vibest report, and read and edit in the project folder", () => {
    for (const id of HARNESS_IDS)
      assert.isEmpty(
        ADAPTERS[id].launchArgs(input).filter((a) => /mcp/i.test(a)),
        id,
      )
    const claude = ADAPTERS.claude.launchArgs(input)
    assert.strictEqual(
      claude[claude.indexOf("--allowedTools") + 1],
      `Bash(vibest report:*),Bash(/usr/bin/bun /src/main.ts report:*),Read(/${input.projectDir}/**),Edit(/${input.projectDir}/**)`,
    )
    assert.strictEqual(claude[claude.indexOf("--add-dir") + 1], input.projectDir)
  })
})

layer(Layer.merge(Platform.services, builtinHarnesses))("on the platform", (it) => {
  it.effect("model listings run in the user's home, not the caller's working directory", () =>
    Effect.gen(function* () {
      const home = yield* tempDirectory("model-home-")
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(`${home}/Library/Keychains`, { recursive: true })
      yield* fs.writeFileString(`${home}/Library/Keychains/login.keychain-db`, "fake keychain; no real CLI")
      const cwds: Array<string | undefined> = []
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          if (command._tag === "StandardCommand") {
            cwds.push(command.options.cwd)
            assert.strictEqual(command.options.env?.HOME, home)
            assert.strictEqual(command.options.extendEnv, true)
          }
          return Effect.fail(PlatformError.badArgument({ module: "test", method: "spawn" }))
        }),
      )
      yield* Effect.gen(function* () {
        const harness = yield* Harness.make()
        yield* Effect.flip(harness.models("pi", null))
        const adapters = yield* Harnesses
        yield* Effect.forEach(["claude", "cursor"] as const, (h) => Effect.flip(listModels(adapters.get(h), null)))
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ HOME: home }), { asPrimary: true })),
      )
      assert.notStrictEqual(process.cwd(), home)
      assert.deepStrictEqual(cwds, [home, home, home])
    }),
  )

  it.effect("Cursor discovery refuses missing and empty Keychains directories on macOS", () =>
    Effect.gen(function* () {
      if (process.platform !== "darwin") return
      const home = yield* tempDirectory("cursor-home-")
      const commands: Array<string> = []
      const spawner = ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") commands.push(command.command)
        return Effect.fail(PlatformError.badArgument({ module: "test", method: "spawn" }))
      })
      const check = Effect.gen(function* () {
        const harness = yield* Harness.make()
        const error = yield* Effect.flip(harness.models("cursor", null))
        assert.include(error.message, "Library/Keychains")
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ HOME: home }), { asPrimary: true })),
      )
      yield* check
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(`${home}/Library/Keychains`, { recursive: true })
      yield* check
      assert.deepStrictEqual(commands, [])
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

  it("a project shows what needs the user most: blocked, then an unseen done, then working, else idle", () => {
    assert.strictEqual(projectActivity(["idle", "working", "done", "blocked"]), "blocked")
    assert.strictEqual(projectActivity(["working", "done", "idle"]), "done")
    assert.strictEqual(projectActivity(["idle", "working", "unknown"]), "working")
    assert.strictEqual(projectActivity(["idle", "unknown"]), "idle")
    assert.strictEqual(projectActivity([]), "idle")
  })

  it("an idle session is done only while its turn is past the mark; no mark (or no runtime support) is never done", () => {
    assert.strictEqual(unseenDone("idle", { turn: 3, seen: 2 }), "done")
    assert.strictEqual(unseenDone("idle", { turn: 3, seen: 3 }), "idle")
    assert.strictEqual(unseenDone("idle", { turn: 3, seen: null }), "idle")
    assert.strictEqual(unseenDone("idle", undefined), "idle")
    assert.strictEqual(unseenDone("working", { turn: 3, seen: 0 }), "working")
    assert.strictEqual(unseenDone("blocked", { turn: 3, seen: 0 }), "blocked")
  })

  it("the seen mark only rises, never past the turn the runtime counted; a missing mark may be set", () => {
    assert.isTrue(raisesSeen({ turn: 3, seen: 2 }, 3))
    assert.isFalse(raisesSeen({ turn: 3, seen: 3 }, 3))
    assert.isFalse(raisesSeen({ turn: 3, seen: 2 }, 1))
    assert.isFalse(raisesSeen({ turn: 3, seen: 2 }, 4))
    assert.isFalse(raisesSeen({ turn: 3, seen: 2 }, 2.5))
    assert.isTrue(raisesSeen({ turn: 3, seen: null }, 0))
    assert.isFalse(raisesSeen({ turn: 3, seen: null }, -1))
    assert.isFalse(raisesSeen({ turn: 3, seen: null }, 1.5))
  })

  it("models --provider: only Pi filters by provider; Claude and Cursor refuse any provider and keep provider null", () => {
    const adapters = {
      get: (id: HarnessId) => ({ binary: id, checkProvider: id === "pi" ? () => undefined : noProvider(id) }),
    }
    const choices: ReadonlyArray<HarnessChoice> = [
      { harness: "claude", problem: null, models: [{ provider: null, model: "opus", name: "Opus", default: true }] },
      {
        harness: "pi",
        problem: null,
        models: [
          { provider: "openai", model: "gpt", name: "GPT", default: true },
          { provider: "anthropic", model: "sonnet", name: "Sonnet", default: false },
        ],
      },
    ]
    assert.deepStrictEqual(catalogModels(choices, adapters, "anthropic"), {
      models: [{ harness: "pi", provider: "anthropic", model: "sonnet", name: "Sonnet", default: false }],
      errors: ["claude: claude has no provider option"],
    })
    assert.deepStrictEqual(catalogModels(choices, adapters, "google"), {
      models: [],
      errors: ["claude: claude has no provider option", 'pi: pi lists no models for provider "google"'],
    })
    assert.deepStrictEqual(
      catalogModels(choices, adapters, null).models.map((m) => [m.harness, m.provider]),
      [
        ["claude", null],
        ["pi", "openai"],
        ["pi", "anthropic"],
      ],
    )
    assert.strictEqual(noProvider("cursor")("anthropic"), "cursor has no provider option")
    assert.isUndefined(noProvider("cursor")(null))
  })

  it.effect("the harness catalog and the start options agree: a harness off PATH has a problem and no models", () =>
    Effect.gen(function* () {
      const [catalog, options] = yield* Effect.all([harnessCatalog, harnessOptions]).pipe(
        Effect.provide(
          Layer.succeed(Harness, {
            available: (id) => Effect.succeed(id !== "cursor"),
            plugin: (id) => Effect.succeed(`/vibest/harnesses/${id}`),
            models: (id) =>
              Effect.succeed([
                { harness: id, provider: "p", model: `${id}-1`, name: "One", description: "d", default: true },
              ]),
          }),
        ),
      )
      assert.deepStrictEqual(
        catalog.find((c) => c.harness === "pi"),
        { harness: "pi", problem: null, models: [{ provider: "p", model: "pi-1", name: "One", default: true }] },
      )
      assert.deepStrictEqual(
        catalog.find((c) => c.harness === "cursor"),
        {
          harness: "cursor",
          problem: "cursor-agent is not on PATH",
          models: [],
        },
      )
      assert.deepStrictEqual(
        options,
        catalog.map((c) =>
          c.problem === null
            ? { harness: c.harness, available: true }
            : { harness: c.harness, available: false, problem: c.problem },
        ),
      )
    }),
  )

  it.effect("turn ends: text field per harness; error marks failure; a junk hook input is no turn end", () =>
    Effect.gen(function* () {
      const harnesses = yield* Harnesses
      assert.deepInclude(turnEndFrom(harnesses.get("claude"), { last_assistant_message: "hi" }, 5), {
        harness: "claude",
        at: 5,
        text: "hi",
        error: undefined,
        interrupted: false,
      })
      assert.deepInclude(turnEndFrom(harnesses.get("pi"), { text: "", error: "boom", error_details: "why" }, 1), {
        error: "boom: why",
      })
      for (const bad of ["--flag", "-f", "--yolo", "--force", "a b", ""])
        assert.deepInclude(turnEndFrom(harnesses.get("cursor"), { text: "x", conversation_id: bad }, 1), {
          conversationId: undefined,
        })
      assert.isUndefined(turnEndOf(harnesses.get("claude"), "general", "{", 1))
    }),
  )

  it.effect(
    "a project is found by the realpath of its directory or of one of its repositories, origin kept as git prints it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const file = path.join(yield* tempDirectory("vibest-identity-"), "vibest.db")
        const repositories = (id: string) => {
          const reader = new Database(file, { readonly: true })
          const rows = reader
            .query("SELECT path, remote_url AS remote FROM project_repository WHERE project_id = ? ORDER BY path")
            .all(id)
          reader.close()
          return rows
        }
        yield* Effect.gen(function* () {
          const db = yield* Db
          const resolve = (directory: string) =>
            Effect.flatMap(locateProject(directory), (located) => resolveProject(db, located))
          const repo = yield* makeRepository
          const first = yield* resolve(repo)
          assert.match(first.id, ID)
          assert.strictEqual(first.directory, repo)
          assert.deepStrictEqual(yield* resolve(repo), first)
          const link = path.join(yield* tempDirectory("vibest-link-"), "l")
          yield* fs.symlink(repo, link)
          assert.deepStrictEqual(yield* resolve(link), first)
          const wt = path.join(yield* tempDirectory("vibest-wt-"), "w")
          yield* sh(repo, "worktree", "add", "-q", "--detach", wt)
          assert.deepStrictEqual(yield* resolve(wt), first)
          assert.deepStrictEqual(repositories(first.id), [{ path: repo, remote: null }])
          yield* sh(repo, "remote", "add", "origin", "git@github.com:A/b.git")
          yield* resolve(repo)
          assert.deepStrictEqual(repositories(first.id), [{ path: repo, remote: "git@github.com:A/b.git" }])
          yield* sh(repo, "remote", "set-url", "origin", "https://github.com/A/b.git")
          yield* resolve(wt)
          assert.deepStrictEqual(repositories(first.id), [{ path: repo, remote: "https://github.com/A/b.git" }])
          const clone = path.join(yield* tempDirectory("vibest-clone-"), "c")
          yield* sh(repo, "clone", "-q", repo, clone)
          yield* sh(clone, "remote", "set-url", "origin", "https://github.com/A/b.git")
          assert.notStrictEqual((yield* resolve(clone)).id, first.id)
          const parent = yield* tempDirectory("vibest-multi-")
          for (const name of ["app", "sdk"]) {
            const child = path.join(parent, name)
            yield* fs.makeDirectory(child)
            yield* sh(child, "init", "-q", "-b", "main")
            yield* sh(
              child,
              "-c",
              "user.email=t@example.com",
              "-c",
              "user.name=t",
              "commit",
              "-q",
              "--allow-empty",
              "-m",
              "i",
            )
          }
          const multi = yield* resolve(parent)
          assert.strictEqual(multi.directory, parent)
          assert.deepStrictEqual(
            repositories(multi.id).map((row) => (row as { path: string }).path),
            [path.join(parent, "app"), path.join(parent, "sdk")],
          )
          assert.deepStrictEqual(yield* resolve(path.join(parent, "app")), multi)
          assert.isUndefined(yield* db.projectAt(yield* tempDirectory("vibest-none-")))
        }).pipe(
          Effect.provide(database(file)),
          Effect.provide(Layer.effect(Layout, Layout.make(path.join(path.dirname(file), "home")))),
        )
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a moved checkout: ProjectMoved; move keeps the id and repairs vibest's worktrees, not the user's; no move, or the old directory still there, is another project",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* tempDirectory("vibest-move-")
        const file = path.join(dir, "vibest.db")
        const home = path.join(dir, "home")
        yield* Effect.gen(function* () {
          const db = yield* Db
          const layout = yield* Layout
          const resolve = (directory: string, move?: boolean) =>
            Effect.flatMap(locateProject(directory), (located) => resolveProject(db, located, move))
          const repo = path.join(dir, "a", "repo")
          yield* fs.makeDirectory(repo, { recursive: true })
          yield* sh(repo, "init", "-q", "-b", "main")
          yield* sh(
            repo,
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "i",
          )
          yield* sh(repo, "remote", "add", "origin", "git@github.com:O/R.git")
          const first = yield* resolve(repo)
          yield* db.insertSession(session("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), first.id, undefined, repo)
          yield* db.insertSession(session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), first.id, undefined, `${repo}/sub`)
          yield* db.insertSession(session("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), first.id, undefined, `${repo}-other`)
          const ours = layout.allocationWorktree("repo", "ab12")
          yield* fs.makeDirectory(path.dirname(ours), { recursive: true })
          yield* sh(repo, "worktree", "add", "-q", "--detach", ours)
          const theirs = path.join(dir, "theirs")
          yield* sh(repo, "worktree", "add", "-q", "--detach", theirs)
          const theirsGit = yield* fs.readFileString(path.join(theirs, ".git"))
          const copy = path.join(dir, "copy")
          yield* sh(dir, "clone", "-q", repo, copy)
          yield* sh(copy, "remote", "set-url", "origin", "git@github.com:O/R.git")
          assert.notStrictEqual((yield* resolve(copy)).id, first.id)
          const moved = path.join(dir, "b", "repo")
          yield* fs.makeDirectory(path.dirname(moved))
          yield* fs.rename(repo, moved)
          const asked = yield* Effect.flip(resolve(moved))
          assert.strictEqual(asked._tag, "ProjectMoved")
          assert.deepStrictEqual(asked._tag === "ProjectMoved" ? [asked.projectId, asked.from, asked.to] : [], [
            first.id,
            repo,
            moved,
          ])
          assert.isUndefined(yield* db.projectAt(moved))
          const done = yield* resolve(moved, true)
          assert.strictEqual(done.id, first.id)
          assert.strictEqual(done.directory, moved)
          assert.deepStrictEqual("moved" in done && done.moved, {
            from: repo,
            repaired: [ours],
            manual: [`git -C ${moved} worktree repair ${theirs}`],
          })
          assert.deepStrictEqual(yield* db.projectAt(moved), { id: first.id, directory: moved })
          assert.strictEqual(yield* db.sessionDirectory("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), moved)
          assert.strictEqual(yield* db.sessionDirectory("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), `${moved}/sub`)
          assert.strictEqual(yield* db.sessionDirectory("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), `${repo}-other`)
          assert.strictEqual(yield* sh(ours, "rev-parse", "--show-toplevel"), yield* fs.realPath(ours))
          assert.strictEqual(yield* fs.readFileString(path.join(theirs, ".git")), theirsGit)
          const again = path.join(dir, "c")
          yield* fs.rename(moved, again)
          const other = yield* resolve(again, false)
          assert.notStrictEqual(other.id, first.id)
          assert.deepStrictEqual(yield* db.projectAt(again), { id: other.id, directory: again })
          assert.strictEqual(yield* db.projectDirectory(first.id), moved)
        }).pipe(Effect.provide(database(file)), Effect.provide(Layer.effect(Layout, Layout.make(home))))
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "a move cut off before it is recorded leaves vibest's worktrees repaired and the project where it was; the next answer moves it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* tempDirectory("vibest-move-")
        yield* Effect.gen(function* () {
          const db = yield* Db
          const layout = yield* Layout
          const resolve = (directory: string, move?: boolean, through = db) =>
            Effect.flatMap(locateProject(directory), (located) => resolveProject(through, located, move))
          const repo = path.join(dir, "a", "repo")
          yield* fs.makeDirectory(repo, { recursive: true })
          yield* sh(repo, "init", "-q", "-b", "main")
          yield* sh(
            repo,
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "i",
          )
          yield* sh(repo, "remote", "add", "origin", "git@github.com:O/R.git")
          const first = yield* resolve(repo)
          const ours = layout.allocationWorktree("repo", "ab12")
          yield* fs.makeDirectory(path.dirname(ours), { recursive: true })
          yield* sh(repo, "worktree", "add", "-q", "--detach", ours)
          const moved = path.join(dir, "b", "repo")
          yield* fs.makeDirectory(path.dirname(moved))
          yield* fs.rename(repo, moved)
          const dyingDb = { ...db, moveProject: () => Effect.die("vibestd stopped") }
          assert.isTrue(Exit.isFailure(yield* Effect.exit(resolve(moved, true, dyingDb))))
          assert.strictEqual(yield* sh(ours, "rev-parse", "--show-toplevel"), yield* fs.realPath(ours))
          assert.strictEqual(yield* db.projectDirectory(first.id), repo)
          assert.strictEqual((yield* Effect.flip(resolve(moved)))._tag, "ProjectMoved")
          const done = yield* resolve(moved, true)
          assert.deepStrictEqual("moved" in done && done.moved, { from: repo, repaired: [], manual: [] })
          assert.deepStrictEqual(yield* db.projectAt(moved), { id: first.id, directory: moved })
        }).pipe(
          Effect.provide(database(path.join(dir, "vibest.db"))),
          Effect.provide(Layer.effect(Layout, Layout.make(path.join(dir, "home")))),
        )
      }).pipe(Effect.provide(Platform.services)),
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
      yield* sh(repo, "remote", "set-url", "origin", "https://example.com/Repo.git/")
      assert.strictEqual(yield* repositoryDirectoryName(repo), "Repo")
      assert.isTrue(safeRepositoryDirectory("MyRepo"))
      assert.isTrue(safeRepositoryDirectory("pi-orchestrator"))
      assert.isFalse(safeRepositoryDirectory("abcd1234-abcd-4abc-8abc-abcd1234abcd"))
      assert.strictEqual(safeRepositoryDirectory("ABCD1234"), !caseFoldedWorktrees)
      assert.isFalse(safeRepositoryDirectory(".."))
      assert.isFalse(safeRepositoryDirectory("a/b"))
      assert.isFalse(safeRepositoryDirectory(""))
    }),
  )

  it.effect(
    "vibest: the main checkout from anywhere inside, linked worktrees included; the main agent's command and env; a refused launch never asks for the session",
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
          plugin: (id) =>
            id === "pi"
              ? Effect.fail(new HarnessUnavailable({ harness: id, message: "vibest's pi plugin is missing: /x/pi" }))
              : Effect.succeed(`/x/${id}`),
          models: () => Effect.succeed([]),
        })
        const claudeDir = yield* tempDirectory("vibest-claude-")
        const tmp = yield* tempDirectory("vibest-tmp-")
        const PROJECT = "0e0e0000-0e0e-40e0-80e0-0e0e00000e0e"
        const run = (
          h: "claude" | "pi" | "cursor",
          harnessSessionId: string | null = null,
          sessionId = "",
          session: Effect.Effect<{
            sessionId: string
            harnessSessionId: string | null
            projectId: string
            runtime?: string
          }> = Effect.succeed({ sessionId, harnessSessionId, projectId: PROJECT }),
          provider: string | null = null,
        ) =>
          Launch.coordinatorCommand({
            harness: h,
            root: repo,
            provider,
            model: null,
            session,
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
        assert.strictEqual((yield* run("claude")).file, "claude")
        const launched = yield* run("claude", null, "abcd1234-abcd-4abc-8abc-abcd1234abcd")
        assert.strictEqual(launched.env.VIBEST_SESSION_ID, "abcd1234-abcd-4abc-8abc-abcd1234abcd")
        const placed = yield* run(
          "claude",
          null,
          "abcd1234-abcd-4abc-8abc-abcd1234abcd",
          Effect.succeed({
            sessionId: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
            harnessSessionId: null,
            projectId: "07e40000-07e4-407e-807e-07e4000007e4",
            runtime: '{"runtime":"herdr"}',
          }),
        )
        assert.strictEqual(placed.env.VIBEST_PROJECT_ID, "07e40000-07e4-407e-807e-07e4000007e4")
        assert.strictEqual(placed.env.VIBEST_RUNTIME, '{"runtime":"herdr"}')
        const unwritten = yield* run("claude", "s1", "abcd1234-abcd-4abc-8abc-abcd1234abcd")
        assert.notInclude(unwritten.args, "--resume")
        assert.notInclude(unwritten.args, "--session-id")
        const transcript = path.join(claudeDir, "projects", repo.replace(/[^a-zA-Z0-9]/g, "-"), "s1.jsonl")
        yield* fs.makeDirectory(path.dirname(transcript), { recursive: true })
        yield* fs.writeFileString(transcript, "{}\n")
        assert.deepStrictEqual((yield* run("claude", "s1", "abcd1234-abcd-4abc-8abc-abcd1234abcd")).args.slice(0, 2), [
          "--resume",
          "s1",
        ])
        let asked = 0
        const counted = Effect.sync(
          () => (
            asked++,
            { sessionId: "abcd1234-abcd-4abc-8abc-abcd1234abcd", harnessSessionId: null, projectId: PROJECT }
          ),
        )
        assert.strictEqual((yield* Effect.flip(run("cursor", null, "", counted)))._tag, "HarnessUnavailable")
        assert.include((yield* Effect.flip(run("pi", null, "", counted))).message, "vibest's pi plugin is missing")
        assert.strictEqual((yield* Effect.flip(run("claude", null, "", counted, "openai")))._tag, "HarnessUnavailable")
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

  const addWorktree = (repo: string) =>
    Effect.gen(function* () {
      const wt = (yield* Path.Path).join(yield* tempDirectory("vibest-wt-"), "w")
      yield* sh(repo, "worktree", "add", "-q", "--detach", wt)
      return wt
    })
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

  it.effect(
    "copyIncluded: .worktreeinclude matches that git ignores, by git's own rules; nothing else; repeatable; without it nothing is copied",
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
        yield* sh(repo, "worktree", "add", "-q", "--detach", `${repo}/.claude/worktrees/sample`)
        yield* sh(repo, "init", "-q", `${repo}/.claude/nested`)
        yield* write(`${repo}/.claude/nested/f`, "n\n")
        const exclude = yield* fs.readFileString(`${repo}/.git/info/exclude`)

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
        assert.strictEqual(yield* sh(wt, "status", "--porcelain"), "")
        assert.strictEqual(yield* fs.readFileString(`${repo}/.git/info/exclude`), exclude)
        assert.deepStrictEqual(yield* copyIncluded(repo, wt), [])
        assert.sameMembers(yield* copyIncluded(repo, yield* addWorktree(repo)), selected)
        assert.strictEqual(yield* fs.readFileString(`${repo}/.git/info/exclude`), exclude)
        yield* fs.remove(`${repo}/.worktreeinclude`)
        const without = yield* addWorktree(repo)
        assert.deepStrictEqual(yield* copyIncluded(repo, without), [])
        for (const f of [".claude", ".env.local", "cache"]) assert.isFalse(yield* fs.exists(`${without}/${f}`), f)
      }),
  )

  it.effect("copyIncluded: only what git ignores both in the main checkout and in the new worktree is copied", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const files = ["committed.env", "shared.dat", "abs.dat", "local.env", "sub/secret.txt", "rel.dat", "inverse.env"]
      yield* policy(repo, "committed.env\ninverse.env\n", files.join("\n") + "\n")
      yield* fs.writeFileString(`${repo}/.gitignore`, "committed.env\nlocal.env\n")
      yield* write(`${repo}/sub/.gitignore`, "secret.txt\n")
      yield* write(`${repo}/rel-exclude`, "rel.dat\n")
      yield* sh(repo, "config", "core.excludesFile", "rel-exclude")
      yield* fs.writeFileString(
        `${repo}/.git/info/exclude`,
        (yield* fs.readFileString(`${repo}/.git/info/exclude`)) + "shared.dat\n",
      )
      for (const f of files) yield* write(`${repo}/${f}`, `${f}\n`)
      const wt = yield* addWorktree(repo)
      assert.sameMembers(yield* copyIncluded(repo, wt), ["committed.env", "shared.dat"])
      assert.strictEqual(yield* sh(wt, "status", "--porcelain", "--untracked-files=all"), "")
      const absoluteExcludes = `${yield* tempDirectory("vibest-excludes-")}/excludes`
      yield* fs.writeFileString(absoluteExcludes, "abs.dat\n")
      yield* sh(repo, "config", "core.excludesFile", absoluteExcludes)
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
      const withOmoHome = yield* layout({ HOME: "/h", OMO_HOME: "/old" })
      assert.deepInclude(withOmoHome, {
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
    assert.strictEqual(parseReport("status: needs_input\nwhich one?").summary, "status: needs_input")
  })

  it("claude startup menus: Down until the accept option is under ❯, then Enter, once", () => {
    const trustDialog = "Do you trust the files in this folder?\n\n ❯ 1. No, exit\n   2. Yes, I trust this folder\n"
    const moved = "Do you trust the files in this folder?\n\n   1. No, exit\n ❯ 2. Yes, I trust this folder\n"
    assert.deepStrictEqual(claudeMenuKey(trustDialog, []), { menu: "trust", key: "down" })
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
    assert.deepStrictEqual(claudeModels([hook, claudeList, claudeApplied("claude-sonnet-5-5")]), [
      { model: "opus", name: "Opus 5.5", description: "complex work", default: false },
      { model: "sonnet", name: "Sonnet 5.5", description: "routine", default: true },
    ])
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
})
