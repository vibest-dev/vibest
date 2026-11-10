import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Sessions } from "@vibest/core/sessions"
import { Effect, Fiber, FileSystem, HashMap, Path, PlatformError } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import { FakeGit } from "./lib/fake-git.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { answerOf, sentBy, until, untilVirtual, writeResult, systemPromptFile } from "./lib/observe.ts"
import { makeRepository } from "./lib/session.ts"
import {
  spawnInput,
  claudeEnd,
  spawnWorking,
  idleSession,
  sessionWorktree,
  test,
  roundAndResultCounts,
  sqlNotices,
} from "./lib/sessions-helpers.ts"

describe.concurrent("Sessions", () => {
  test(
    "resuming a session writes today's system prompt and leaves the repository's own files alone",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const layout = yield* Layout
      const repo = yield* makeRepository
      const { id, sessions } = yield* spawnWorking(repo)
      assert.notInclude(yield* fs.readFileString(yield* systemPromptFile(id)), "learned between starts")
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const cursorMcp = `${yield* sessionWorktree(id)}/.cursor/mcp.json`
      yield* fs.makeDirectory(`${yield* sessionWorktree(id)}/.cursor`, { recursive: true })
      yield* fs.writeFileString(cursorMcp, JSON.stringify({ mcpServers: { repo: { command: "repo-server" } } }))
      yield* fs.writeFileString(yield* systemPromptFile(id), "use the send_message tool")
      const memory = `${layout.project(String((yield* (yield* Db).getSession(id))!.projectId))}/memories`
      yield* fs.makeDirectory(memory, { recursive: true })
      yield* fs.writeFileString(`${memory}/later.md`, "learned between starts")
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      const db = yield* Db
      yield* sessions.check(id)
      yield* untilVirtual(db.getSession(id), (row) => row?.exitedAt != null)
      yield* sessions.send(id, "next")
      yield* untilVirtual(herdr.callsTo("send"), (calls) => calls.some((call) => call.text === "next"))
      assert.isTrue(yield* fs.exists(cursorMcp))
      const prompt = yield* fs.readFileString(yield* systemPromptFile(id))
      assert.include(prompt, "send ")
      assert.notInclude(prompt, "send_message")
      assert.include(prompt, "learned between starts")
    }),
    { hooked: ["pi"] },
  )

  test(
    "prompt that never registers: Enter, one re-paste, then task_not_started",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const { id } = yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository))
      yield* untilVirtual(db.getSession(id), (w) => w?.turnState === "not_started")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "not_started")
      const sends = (yield* herdr.callsTo("send")).slice(1)
      assert.lengthOf(sends, 2)
      assert.deepStrictEqual(sends[0]!.keys, ["enter"])
      const row = yield* db.latestInbox(id, "notice")
      assert.include(row!.message, "task_not_started")
      assert.include(row!.message, `to see its terminal, run: vibest peek ${id}`)
      assert.notInclude(row!.message, "pane tail")
    }),
    { promptsIgnored: true },
  )

  test(
    "a later send whose Enter is swallowed gets Enter again: the previous round's start is no pickup",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* spawnWorking(yield* makeRepository)
      yield* sessions.userPrompt(id, "do it")
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      yield* TestClock.adjust("1 second")
      yield* herdr.updateAgent(id, (a) => ({ ...a, registerPrompt: false }))
      yield* sessions.send(id, "next")
      const sends = yield* untilVirtual(herdr.callsTo("send"), (calls) => {
        const at = calls.findIndex((c) => c.text === "next")
        return at >= 0 && calls.length > at + 1
      })
      assert.deepStrictEqual(sends[sends.findIndex((c) => c.text === "next") + 1]!.keys, ["enter"])
    }),
    { hooked: ["pi"] },
  )

  test(
    "a queued message the session never starts on: task_not_started fails that batch and tells the owner, with the text",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const db = yield* Db
      const { id } = yield* sessions.spawn(yield* spawnInput(yield* makeRepository))
      yield* untilVirtual(db.getSession(id), (w) => w?.turnState === "not_started")
      yield* sessions.send(id, "next")
      const notices = yield* untilVirtual(sqlNotices(id), (m) => m.length === 2)
      assert.match(
        notices[1]!,
        new RegExp(`^A message to ${id} was not delivered: task_not_started: .*\\n\\nnext$`, "s"),
      )
      assert.deepStrictEqual(
        (yield* (yield* SqlClient.SqlClient)<{
          status: string
        }>`SELECT status AS status FROM inbox WHERE recipient_session_id = ${id} AND kind IN ('task', 'send') AND id > (SELECT min(id) FROM inbox WHERE recipient_session_id = ${id} AND kind IN ('task', 'send'))`.pipe(
          Effect.orDie,
        )).map((r) => r.status),
        ["failed"],
      )
      assert.lengthOf((yield* herdr.callsTo("send")).slice(1), 5)
    }),
    { promptsIgnored: true },
  )

  test(
    "a queued message stays pending while the session is not ready; once herdr has it, it is sending",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* idleSession(yield* makeRepository)
      const notReady = yield* herdr.hold("state", id)
      yield* sessions.send(id, "next")
      yield* notReady.reached
      const status = Effect.map(db.inboxWithStatus(id, "pending"), (rows) => rows.map((r) => r.message))
      assert.deepStrictEqual(yield* status, ["next"])
      const held = yield* herdr.hold("send", id)
      yield* notReady.release()
      yield* TestClock.adjust("1 second")
      yield* held.reached
      assert.deepStrictEqual(
        (yield* db.inboxWithStatus(id, "sending")).map((r) => r.message),
        ["next"],
      )
      yield* held.release()
      yield* until(db.inboxWithStatus(id, "delivered"), (rows) => rows.length === 1)
    }),
    { hooked: ["pi"] },
  )

  test(
    "launch failure rolls back the worktree and notifies the owner",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const db = yield* Db
      const { id } = yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository))
      yield* until(db.getSession(id), (w) => !!w && w.exitedAt !== null)
      assert.isFalse(yield* fs.exists(yield* sessionWorktree(id)))
      assert.isFalse(yield* fs.exists(yield* systemPromptFile(id)))
      yield* (yield* Sessions).check(id)
      const failed = (yield* db.getSession(id))!
      assert.strictEqual(failed.status, "unknown")
      assert.isNotNull(failed.exitedAt)
      assert.deepStrictEqual(yield* (yield* FakeRuntime).callsTo("close"), [])
      const row = yield* db.latestInbox(id, "notice")
      assert.strictEqual(row!.kind, "notice")
      assert.include(row!.message, "failed to start pi")
    }),
    { startError: "spawn_failed" },
  )

  test(
    "a resume whose start fails closes the pane it placed",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false }))
      const placed = (yield* herdr.callsTo("open")).length
      const held = yield* herdr.hold("open", id)
      yield* sessions.send(id, "again")
      yield* held.reached
      yield* held.release("failed")
      yield* until(herdr.callsTo("open"), (calls) => calls.length === placed + 1)
      assert.deepStrictEqual(yield* herdr.callsTo("close"), [])
      const notice = yield* until(sqlNotices(id), (rows) =>
        rows.some((message) => message.includes("A message to") && message.includes("again")),
      )
      assert.include(notice.at(-1)!, "open: failed")
    }),
    { hooked: ["pi"] },
  )

  test(
    "a copy failure fails the launch before the harness starts, names the copy, and still rolls the worktree back",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Db
      const repo = yield* makeRepository
      yield* fs.makeDirectory(path.join(repo, "cfg"))
      yield* fs.writeFileString(path.join(repo, "cfg", "x"), "x\n")
      yield* fs.writeFileString(path.join(repo, "a.json"), "{}\n")
      yield* (yield* FakeGit).update(repo, {
        files: { "README.md": "hi\n", cfg: "a tracked file\n" },
        includes: ["a.json", "cfg/x"],
      })
      const { id } = yield* (yield* Sessions).spawn(yield* spawnInput(repo))
      yield* until(db.getSession(id), (w) => !!w && w.exitedAt !== null)
      assert.lengthOf(yield* (yield* FakeRuntime).callsTo("open"), 0)
      const row = yield* db.latestInbox(id, "notice")
      assert.include(
        row!.message,
        `failed to start pi: copy ${path.join(repo, "cfg", "x")} -> ${path.join(yield* sessionWorktree(id), "cfg", "x")}`,
      )
      assert.include(row!.message, "(ENOTDIR)")
      assert.isFalse(yield* fs.exists(yield* sessionWorktree(id)))
    }),
  )

  test(
    "a copy that fails after an earlier one succeeded still fails the launch, and git rolls back the partly filled worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = yield* Db
      const repo = yield* makeRepository
      for (const f of ["a.json", "b.json"]) yield* fs.writeFileString(path.join(repo, f), `${f}\n`)
      const fakeGit = yield* FakeGit
      yield* fakeGit.update(repo, { includes: ["a.json", "b.json"] })
      const copied: Array<string> = []
      const faulty = FileSystem.FileSystem.of({
        ...fs,
        copyFile: (from: string, to: string) =>
          path.basename(to) === "b.json"
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "copyFile",
                  pathOrDescriptor: from,
                  cause: Object.assign(new Error("EIO"), { code: "EIO" }),
                }),
              )
            : fs.copyFile(from, to).pipe(Effect.tap(() => Effect.sync(() => copied.push(to)))),
      })
      const sessions = yield* Sessions.make({ maxSessions: undefined }).pipe(
        Effect.provideService(FileSystem.FileSystem, faulty),
      )
      const { id } = yield* sessions.spawn(yield* spawnInput(repo))
      yield* until(db.getSession(id), (w) => !!w && w.exitedAt !== null)
      const worktree = yield* sessionWorktree(id)
      assert.deepStrictEqual(copied, [path.join(worktree, "a.json")])
      assert.lengthOf(yield* (yield* FakeRuntime).callsTo("open"), 0)
      const row = yield* db.latestInbox(id, "notice")
      assert.include(
        row!.message,
        `failed to start pi: copy ${path.join(repo, "b.json")} -> ${path.join(worktree, "b.json")}`,
      )
      assert.include(row!.message, "(EIO)")
      assert.isFalse(yield* fs.exists(worktree))
      assert.notInclude(yield* fakeGit.git.linkedWorktrees(repo), worktree)
      for (const f of ["a.json", "b.json"]) assert.strictEqual(yield* fs.readFileString(path.join(repo, f)), `${f}\n`)
    }),
  )

  test(
    "VIBEST_MAX_SESSIONS counts every non-stopped session",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      yield* spawnWorking(repo)
      const error = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(repo)))
      assert.strictEqual(error._tag, "LimitReached")
    }),
    { maxSessions: 1 },
  )

  test(
    "claude and cursor refuse any provider, anthropic too, before anything is created",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      for (const harness of ["claude", "cursor"] as const)
        for (const provider of ["openai", "anthropic"]) {
          const error = yield* Effect.flip(
            (yield* Sessions).spawn({ ...(yield* spawnInput(yield* makeRepository, harness)), provider }),
          )
          assert.strictEqual(error._tag, "HarnessUnavailable")
          assert.isTrue(error.message.startsWith(`${harness} has no provider option`), error.message)
        }
      assert.strictEqual(yield* herdr.callCount, 0)
    }),
  )

  test(
    "remove keeps what git would lose (changes, untracked files, commits on no branch, a lock) and tries again when asked",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fakeGit = yield* FakeGit
      const repo = yield* makeRepository
      const kept = (out: { readonly worktree: string; readonly reasons: ReadonlyArray<string> }, why: string) => {
        assert.strictEqual(out.worktree, "kept")
        assert.match(out.reasons.join("\n"), new RegExp(why))
      }
      const a = yield* idleSession(repo)
      const wa = yield* sessionWorktree(a.id)
      const dirty = { branch: "", pushed: false, saved: false, why: "uncommitted changes" }
      yield* fakeGit.checkout(wa, { state: dirty })
      kept((yield* a.sessions.remove(a.id))!, "uncommitted changes")
      assert.isNotNull((yield* a.db.getSession(a.id))!.exitedAt)
      assert.isTrue(yield* fs.exists(yield* systemPromptFile(a.id)))
      kept((yield* a.sessions.remove(a.id))!, "uncommitted changes")
      yield* fakeGit.checkout(wa, { state: { branch: "keep/a", pushed: false, saved: true, why: "" } })
      assert.deepInclude((yield* a.sessions.remove(a.id))!, { worktree: "removed", branch: "keep/a" })

      const b = yield* idleSession(repo)
      const wb = yield* sessionWorktree(b.id)
      yield* fakeGit.checkout(wb, {
        state: { branch: "", pushed: false, saved: false, why: "commits not on any branch" },
      })
      kept((yield* b.sessions.remove(b.id))!, "commits not on any branch")
      yield* fakeGit.checkout(wb, { state: { branch: "", pushed: false, saved: true, why: "" } })
      assert.deepInclude((yield* b.sessions.remove(b.id))!, { worktree: "removed", branch: null })

      const c = yield* idleSession(repo)
      yield* fakeGit.checkout(yield* sessionWorktree(c.id), {
        refuseRemove: "fatal: cannot remove a locked working tree, lock reason: initializing",
      })
      kept((yield* c.sessions.remove(c.id))!, "git refused")
      assert.isTrue(yield* fs.exists(yield* sessionWorktree(c.id)))

      const d = yield* idleSession(repo)
      assert.deepInclude((yield* d.sessions.remove(d.id, { keepWorktree: true }))!, {
        worktree: "kept",
        reasons: ["worktree kept as asked (--keep-worktree)"],
      })
      assert.isTrue(yield* fs.exists(yield* sessionWorktree(d.id)))
    }),
  )

  test(
    "remove: files git calls clean do not keep the worktree, a copied .worktreeinclude file included; what git calls uncommitted does",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fakeGit = yield* FakeGit
      const repo = yield* makeRepository
      const a = yield* idleSession(repo)
      yield* fs.writeFileString(`${yield* sessionWorktree(a.id)}/local.env`, "K=1\n")
      assert.deepInclude((yield* a.sessions.remove(a.id))!, { worktree: "removed", reasons: [] })
      assert.isFalse(yield* fs.exists(yield* sessionWorktree(a.id)))

      yield* fakeGit.update(repo, { includes: ["CLAUDE.md"] })
      const b = yield* idleSession(repo)
      assert.strictEqual(yield* fs.readFileString(`${yield* sessionWorktree(b.id)}/CLAUDE.md`), "local rules\n")
      yield* fs.writeFileString(`${yield* sessionWorktree(b.id)}/CLAUDE.md`, "edited in the worktree\n")
      assert.deepInclude((yield* b.sessions.remove(b.id))!, { worktree: "removed", reasons: [] })
      assert.strictEqual(yield* fs.readFileString(`${repo}/CLAUDE.md`), "local rules\n")

      const c = yield* idleSession(repo)
      yield* fs.writeFileString(`${yield* sessionWorktree(c.id)}/notes.txt`, "mine\n")
      const dirty = { branch: "", pushed: false, saved: false, why: "uncommitted changes" }
      yield* fakeGit.checkout(yield* sessionWorktree(c.id), { state: dirty })
      const out = (yield* c.sessions.remove(c.id))!
      assert.strictEqual(out.worktree, "kept")
      assert.match(out.reasons.join("\n"), /uncommitted changes/)
      assert.strictEqual(yield* fs.readFileString(`${yield* sessionWorktree(c.id)}/notes.txt`), "mine\n")
      assert.isTrue(yield* fs.exists(`${yield* sessionWorktree(c.id)}/CLAUDE.md`))
      yield* fs.remove(`${yield* sessionWorktree(c.id)}/notes.txt`)
      yield* fs.writeFileString(`${yield* sessionWorktree(c.id)}/README.md`, "modified")
      yield* fakeGit.checkout(yield* sessionWorktree(c.id), { state: dirty })
      assert.deepInclude((yield* c.sessions.remove(c.id))!, {
        worktree: "kept",
        reasons: ["worktree kept: uncommitted changes"],
      })
    }),
  )

  test(
    "a Send accepted just before vibest rm does not bring the removed session back; its message fails once",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      const counts = Effect.all([herdr.callsTo("open"), herdr.callsTo("send")]).pipe(
        Effect.map((calls) => calls.map((c) => c.length)),
      )
      const before = yield* counts
      const held = yield* herdr.hold("state", id)
      const removing = yield* Effect.forkChild(sessions.remove(id, { keepWorktree: true }))
      yield* held.reached
      yield* sessions.send(id, "late")
      yield* held.release()
      assert.deepInclude(yield* Fiber.join(removing), { worktree: "kept" })
      yield* TestClock.withLive(Effect.sleep("100 millis"))
      yield* sessions.check(id)
      assert.deepStrictEqual(yield* counts, before)
      const notices = yield* sqlNotices(id)
      assert.deepStrictEqual(
        notices.filter((m) => m.endsWith("\n\nlate")),
        [`A message to ${id} was not delivered: ${id} was archived before it was delivered\n\nlate`],
      )
      assert.deepInclude(yield* sessions.remove(id), { worktree: "removed" })
    }),
  )

  test(
    "remove closes the session's own pane after its harness exited (a shell left in it); a pane with no process in the worktree no longer keeps it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const a = yield* idleSession(repo)
      yield* herdr.updateAgent(a.id, (x) => ({ ...x, alive: false }))
      assert.deepInclude((yield* a.sessions.remove(a.id))!, {
        pane: "closed",
        workspace: "none",
        worktree: "removed",
        reasons: [],
      })
      assert.isFalse(yield* fs.exists(yield* sessionWorktree(a.id)))

      const b = yield* idleSession(repo)
      yield* herdr.updateAgent(b.id, (x) => ({ ...x, alive: false }))
      yield* herdr.addPane("user:3", "elsewhere", yield* sessionWorktree(b.id))
      assert.deepInclude((yield* b.sessions.remove(b.id))!, { pane: "closed", worktree: "removed" })
      assert.isTrue(HashMap.has(yield* herdr.panes, "user:3"))
    }),
  )

  test(
    "a session removed with --keep-worktree is never resumed; rm again removes the worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const { id, sessions } = yield* idleSession(yield* makeRepository)
      assert.deepInclude(yield* sessions.remove(id, { keepWorktree: true }), { worktree: "kept" })
      const starts = (yield* herdr.callsTo("open")).length
      assert.strictEqual(
        (yield* Effect.flip(sessions.send(id, "come back"))).message,
        `${id} was archived; run a new session`,
      )
      yield* sessions.check(id)
      assert.lengthOf(yield* herdr.callsTo("open"), starts)
      assert.deepInclude(yield* sessions.remove(id), { worktree: "removed" })
      assert.isFalse(yield* fs.exists(yield* sessionWorktree(id)))
    }),
  )

  test(
    "remove of a worktree that is gone, or not this repository's, reconciles its processes and leaves the directory alone",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repo = yield* makeRepository
      const a = yield* idleSession(repo)
      yield* fs.remove(yield* sessionWorktree(a.id), { recursive: true })
      assert.deepInclude((yield* a.sessions.remove(a.id))!, { pane: "closed", workspace: "none", worktree: "gone" })
      assert.isNotNull((yield* a.db.getSession(a.id))!.exitedAt)

      const b = yield* idleSession(repo)
      const wb = yield* sessionWorktree(b.id)
      const fakeGit = yield* FakeGit
      yield* fakeGit.git.removeWorktree(repo, wb)
      yield* fs.makeDirectory(wb)
      yield* fakeGit.repository(wb)
      yield* fs.writeFileString(`${wb}/mine.txt`, "the user's")
      const out = (yield* b.sessions.remove(b.id))!
      assert.deepInclude(out, { worktree: "kept" })
      assert.match(out.reasons.join("\n"), /not a worktree of its repository/)
      assert.isTrue(yield* fs.exists(`${wb}/mine.txt`))
    }),
  )

  test(
    "interrupt stops the turn but keeps the session; no result arrives, and the next message goes straight in",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      assert.include((yield* sessions.interrupt(id)).message, "interrupted")
      assert.deepStrictEqual((yield* herdr.callsTo("send")).at(-1)!.keys, ["esc"])
      assert.strictEqual((yield* db.getSession(id))!.turnState, "interrupted")
      assert.isTrue(yield* fs.exists(yield* sessionWorktree(id)))
      yield* TestClock.adjust("11 seconds")
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.status, "idle")
      assert.deepStrictEqual(yield* db.coordinatorPending((yield* db.getSession(id))!.projectId), [])
      yield* sessions.send(id, "do it differently")
      yield* until(db.getSession(id), (w) => w?.turnState === "open")
    }),
  )

  test(
    "vibest interrupt (pi): the aborted turn end its Esc makes is no result, no inbox row and no new round",
    Effect.gen(function* () {
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "pi")
      assert.include((yield* sessions.interrupt(id)).message, "interrupted")
      const before = yield* roundAndResultCounts(id)
      yield* writeResult(id, "pi", { text: "", error: "aborted", aborted: true }, 60_000)
      yield* TestClock.adjust("2 minutes")
      yield* sessions.check(id)
      const row = (yield* db.getSession(id))!
      assert.strictEqual(row.turnState, "interrupted")
      assert.deepStrictEqual(yield* sentBy(id), [])
      assert.deepStrictEqual(yield* db.coordinatorPending(row.projectId), [])
      assert.deepStrictEqual(yield* roundAndResultCounts(id), before)
      assert.strictEqual(before.results, 0)
    }),
    { hooked: ["pi"] },
  )

  for (const harness of ["claude", "pi"] as const)
    test(
      `remove of a working ${harness} session: the aborted turn end of its interrupt is no result, written during the interrupt or after`,
      Effect.gen(function* () {
        const herdr = yield* FakeRuntime
        const repo = yield* makeRepository
        const aborted = harness === "claude" ? claudeEnd("aborted") : { text: "", error: "aborted", aborted: true }
        const during = yield* spawnWorking(repo, harness)
        const held = yield* herdr.hold("send", during.id)
        const removing = yield* Effect.forkChild(during.sessions.remove(during.id))
        yield* held.reached
        yield* writeResult(during.id, harness, aborted, 60_000)
        yield* held.release()
        yield* Fiber.join(removing)
        const after = yield* spawnWorking(repo, harness)
        yield* after.sessions.remove(after.id)
        yield* writeResult(after.id, harness, aborted, 60_000)
        yield* TestClock.adjust("2 minutes")
        for (const { id, sessions, db } of [during, after]) {
          const row = (yield* db.getSession(id))!
          assert.isTrue(row.metadata.archived, id)
          yield* sessions.check(id)
          assert.deepStrictEqual(yield* roundAndResultCounts(id), { rounds: 1, results: 0 }, id)
          assert.strictEqual((yield* db.getSession(id))!.turnState, "interrupted", id)
          assert.deepStrictEqual(yield* db.coordinatorPending(row.projectId), [])
        }
      }),
      harness === "pi" ? { hooked: ["pi"] } : undefined,
    )

  test(
    "interrupt keeps the answer that is already in instead of discarding it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      assert.include((yield* sessions.interrupt(id)).message, "already finished")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "completed")
      assert.deepStrictEqual((yield* herdr.callsTo("send")).slice(1), [])
      assert.strictEqual(yield* answerOf(id), "status: completed")
      assert.deepStrictEqual(yield* db.coordinatorPending((yield* db.getSession(id))!.projectId), [])
    }),
    { hooked: ["pi"] },
  )

  test(
    "interrupt of an idle session changes nothing",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.include((yield* sessions.interrupt(id)).message, "not working")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "completed")
    }),
    { hooked: ["pi"] },
  )

  test(
    "interrupt of a turn vibest saw start stops it while the runtime still shows the agent idle",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository)
      yield* herdr.updateAgent(id, (a) => ({ ...a, status: "idle" }))
      assert.include((yield* sessions.interrupt(id)).message, "interrupted")
      assert.deepStrictEqual((yield* herdr.callsTo("send")).at(-1)!.keys, ["esc"])
      assert.strictEqual((yield* db.getSession(id))!.turnState, "interrupted")
    }),
    { hooked: ["pi"] },
  )

  test(
    "interrupt that does not take: SessionBusy, the round stays open, so the late aborted turn.complete is delivered as an interrupted result",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "claude")
      const interrupting = yield* Effect.forkChild(sessions.interrupt(id))
      yield* untilVirtual(
        Effect.sync(() => interrupting.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      assert.strictEqual((yield* Effect.flip(Fiber.join(interrupting)))._tag, "SessionBusy")
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")
      yield* writeResult(id, "claude", claudeEnd("aborted"))
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "failed")
      assert.include(
        (yield* db.latestInbox(id, "notice"))!.message,
        "interrupted: the turn was stopped in its terminal (Esc) before it ended",
      )
    }),
    { interruptIgnored: true },
  )

  test(
    "vibest interrupt while background work keeps the terminal working: an aborted turn end that lands before the Esc send returns closes the round as interrupted, with no result",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { id, sessions, db } = yield* spawnWorking(yield* makeRepository, "claude")
      const held = yield* herdr.hold("send")
      const interrupting = yield* Effect.forkChild(sessions.interrupt(id))
      yield* held.reached
      yield* writeResult(id, "claude", claudeEnd("aborted"))
      yield* held.release()
      yield* untilVirtual(
        Effect.sync(() => interrupting.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      assert.include((yield* Fiber.join(interrupting)).message, "interrupted")
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "interrupted")
      assert.deepStrictEqual(yield* sentBy(id), [])
    }),
    { interruptIgnored: true },
  )
})
