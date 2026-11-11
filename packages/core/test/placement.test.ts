import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Sessions } from "@vibest/core/sessions"
import { repositoryDirectoryName } from "@vibest/core/worktree"
import { Effect, FileSystem, HashMap, PubSub } from "effect"

import { KIND as RUNTIME } from "../../runtime-herdr/src/terminal-runtime.ts"
import { projectOf } from "./lib/directory.ts"
import { testEffect } from "./lib/effect.ts"
import { FakeGit } from "./lib/fake-git.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { until, writeEnd } from "./lib/observe.ts"
import { makeRepository, sessionLayer } from "./lib/session.ts"

const test = <E, R>(name: string, program: Effect.Effect<void, E, R>) => testEffect(sessionLayer())(name, () => program)

const spawnInput = (repo: string) =>
  Effect.map(projectOf(repo), (projectId) => ({
    machine: { id: "local" },
    root: repo,
    projectId,
    name: "task",
    prompt: "do it",
    harness: "pi" as const,
    runtime: "herdr",
  }))

describe("placement: every session is a tab beside the project's entry session, in vibest's own detached worktree", () => {
  test(
    "a subagent is a tab in the entry session's workspace with its shell in a detached worktree; labelled, labelled again after a restart, archived without closing that workspace",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      yield* herdr.addWorkspace("main", repo)
      yield* herdr.addPane("main:coord", "main", repo)
      yield* db.startEntry(yield* projectOf(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "main:coord" },
      })

      const { id } = yield* sessions.spawn(yield* spawnInput(repo))
      yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => w?.executionState === "open")
      const wt = (yield* sessions.get(id)).worktree
      const placed = (yield* herdr.callsTo("open"))[0]!
      assert.deepStrictEqual([placed.near, placed.project, placed.cwd], ["main:coord", repo, wt])
      assert.strictEqual((yield* herdr.agent(id))!.terminal.split(":")[0], "main")
      assert.deepStrictEqual(yield* (yield* FakeGit).git.linkedWorktrees(repo), [wt])
      const shown = (yield* herdr.callsTo("present"))[0]!
      assert.deepInclude(shown, {
        terminal: (yield* herdr.agent(id))!.terminal,
        info: {
          agent: "general",
          harness: "pi",
          title: "task",
          definition: "general",
          session: id,
          project: yield* repositoryDirectoryName(repo),
          live: "1",
        },
      })

      yield* PubSub.publish(herdr.events, { type: "reset" })
      yield* until(herdr.callsTo("present"), (calls) => calls.length > 1)

      yield* writeEnd(id, "pi", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* sessions.remove(id), { pane: "closed", worktree: "removed" })
      assert.isFalse(yield* fs.exists(wt))
      assert.isTrue(HashMap.has(yield* herdr.panes, "main:coord"))
    }),
  )

  test(
    "the project workspace's live count is published again when a session's harness exits, and when the last one is archived the entry session's terminal publishes the count alone with no pane metadata",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      yield* herdr.addWorkspace("main", repo)
      yield* herdr.addPane("main:coord", "main", repo)
      yield* db.startEntry(
        yield* projectOf(repo),
        "pi",
        false,
        { runtime: RUNTIME, address: { machine: "local", id: "main:coord" } },
        { projectDirectory: repo },
      )

      const a = yield* sessions.spawn(yield* spawnInput(repo))
      const b = yield* sessions.spawn({ ...(yield* spawnInput(repo)), name: "second" })
      yield* until(db.getSession(a.id), (w): w is NonNullable<typeof w> => w?.executionState === "open")
      yield* until(db.getSession(b.id), (w): w is NonNullable<typeof w> => w?.executionState === "open")
      yield* until(herdr.callsTo("present"), (calls) => calls.at(-1)!.info.live === "2")

      yield* herdr.updateAgent(a.id, (agent) => ({ ...agent, alive: false }))
      yield* sessions.check(a.id)
      assert.deepInclude((yield* herdr.callsTo("present")).at(-1)!.info, { live: "1" })

      yield* sessions.remove(b.id)
      const last = (yield* herdr.callsTo("present")).at(-1)!
      assert.deepInclude(last, { terminal: "main:coord" })
      assert.deepInclude(last.info, { live: "0", agent: "", harness: "", title: "", definition: "", session: "" })
    }),
  )

  test(
    "an entry session in another herdr session does not place near its pane id: the id repeats in every session; the workspace still resolves by the project",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      yield* herdr.addWorkspace("w1", repo)
      yield* herdr.addPane("w1:coord", "w1", repo)
      yield* db.startEntry(yield* projectOf(repo), "pi", false, {
        runtime: "other",
        address: { machine: "local", id: "w1:coord" },
      })

      const { id } = yield* sessions.spawn(yield* spawnInput(repo))
      yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => w?.executionState === "open")
      const placed = (yield* herdr.callsTo("open"))[0]!
      assert.strictEqual(placed.near, undefined)
      assert.strictEqual((yield* herdr.agent(id))!.terminal.split(":")[0], "w1")
    }),
  )

  test(
    "an agent another machine started is opened as remote; one started here is not",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      const here = yield* sessions.spawn(yield* spawnInput(repo))
      const there = yield* sessions.spawn({ ...(yield* spawnInput(repo)), origin: { peer: "a", project: "aproj" } })
      for (const id of [here.id, there.id])
        yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => w?.executionState === "open")
      const opened = yield* herdr.callsTo("open")
      const openOf = (id: string) => opened.find((call) => call.env.VIBEST_SESSION_ID === id)
      const hereOpen = openOf(here.id)
      const thereOpen = openOf(there.id)
      assert.isDefined(hereOpen)
      assert.isDefined(thereOpen)
      assert.strictEqual(hereOpen.remote, undefined)
      assert.strictEqual(thereOpen.remote, true)
    }),
  )
})
