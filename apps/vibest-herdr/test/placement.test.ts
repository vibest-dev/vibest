// Every session is a tab beside the project's main agent. A worktree is vibest's own (detached), never herdr's.
import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Sessions } from "@vibest/core/sessions"
import { repositoryDirectoryName } from "@vibest/core/worktree"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Effect, FileSystem, HashMap, PubSub, type Scope } from "effect"

import {
  FakeRuntime,
  makeRepository,
  sh,
  testLayer,
  type TestServices,
  until,
  writeResult,
  projectOf,
} from "./fakes.ts"

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer())))

const spawnInput = (repo: string) =>
  Effect.map(projectOf(repo), (projectId) => ({
    machine: { id: "local" },
    root: repo,
    projectId,
    name: "task",
    prompt: "do it",
    harness: "pi" as const,
  }))

describe("placement", () => {
  test(
    "a subagent is a tab in the main agent's workspace with its shell in a detached worktree; labelled, labelled again after a restart, archived without closing that workspace",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      yield* herdr.addWorkspace("main", repo)
      yield* herdr.addPane("main:coord", "main", repo)
      yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "main:coord" },
      })

      const { id } = yield* sessions.spawn(yield* spawnInput(repo))
      yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => w?.turnState === "open")
      const wt = (yield* sessions.get(id)).worktree
      const placed = (yield* herdr.callsTo("open"))[0]!
      assert.deepStrictEqual([placed.near, placed.project, placed.cwd], ["main:coord", repo, wt])
      assert.strictEqual((yield* herdr.agent(id))!.terminal.split(":")[0], "main")
      assert.strictEqual(yield* sh(wt, "branch", "--show-current"), "")
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

      // The runtime came back (its labels gone): every live session's terminal is labelled again.
      yield* PubSub.publish(herdr.events, { type: "reset", machine: "local" })
      yield* until(herdr.callsTo("present"), (calls) => calls.length > 1)

      yield* writeResult(id, "pi", { text: "status: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      assert.deepInclude(yield* sessions.remove(id), { pane: "closed", worktree: "removed" })
      assert.isFalse(yield* fs.exists(wt))
      assert.isTrue(HashMap.has(yield* herdr.panes, "main:coord"))
    }),
  )

  test(
    "the project workspace's live count is published again when a session ends, and when the last one is archived",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      yield* herdr.addWorkspace("main", repo)
      yield* herdr.addPane("main:coord", "main", repo)
      yield* db.coordinatorLaunch(
        yield* projectOf(repo),
        "pi",
        false,
        { runtime: RUNTIME, address: { machine: "local", id: "main:coord" } },
        { projectDirectory: repo },
      )

      const a = yield* sessions.spawn(yield* spawnInput(repo))
      const b = yield* sessions.spawn({ ...(yield* spawnInput(repo)), name: "second" })
      yield* until(db.getSession(a.id), (w): w is NonNullable<typeof w> => w?.turnState === "open")
      yield* until(db.getSession(b.id), (w): w is NonNullable<typeof w> => w?.turnState === "open")
      yield* until(herdr.callsTo("present"), (calls) => calls.at(-1)!.info.live === "2")

      // The harness of a exits: its terminal relabels the workspace without it.
      yield* herdr.updateAgent(a.id, (agent) => ({ ...agent, alive: false }))
      yield* sessions.check(a.id)
      assert.deepInclude((yield* herdr.callsTo("present")).at(-1)!.info, { live: "1" })

      // The last live session archived: the main agent's terminal publishes the count alone, with no pane metadata.
      yield* sessions.remove(b.id)
      const last = (yield* herdr.callsTo("present")).at(-1)!
      assert.deepInclude(last, { terminal: "main:coord" })
      assert.deepInclude(last.info, { live: "0", agent: "", harness: "", title: "", definition: "", session: "" })
    }),
  )

  test(
    "a main agent in another herdr session does not place near its pane id: the id repeats in every session",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const sessions = yield* Sessions
      const repo = yield* makeRepository
      // The main agent of another runtime does not place near its terminal: pane ids are the runtime's own.
      yield* herdr.addWorkspace("w1", repo)
      yield* herdr.addPane("w1:coord", "w1", repo)
      yield* db.coordinatorLaunch(yield* projectOf(repo), "pi", false, {
        runtime: "other",
        address: { machine: "local", id: "w1:coord" },
      })

      const { id } = yield* sessions.spawn(yield* spawnInput(repo))
      yield* until(db.getSession(id), (w): w is NonNullable<typeof w> => w?.turnState === "open")
      const placed = (yield* herdr.callsTo("open"))[0]!
      assert.strictEqual(placed.near, undefined)
      // Its workspace still resolves by the project; only the other runtime's terminal does not place it.
      assert.strictEqual((yield* herdr.agent(id))!.terminal.split(":")[0], "w1")
    }),
  )
})
