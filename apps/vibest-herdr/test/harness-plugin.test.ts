// A harness a plugin registers with `context.harness.register` runs like a built-in: `vibest run <id>` starts it.
import { assert, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Sessions } from "@vibest/core/sessions"
import { repositoryKey } from "@vibest/core/worktree"
import { Plugin } from "@vibest/plugin"
import type { Harness } from "@vibest/plugin"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Effect } from "effect"

import { FakeRuntime, makeRepository, testLayer, until } from "./fakes.ts"

const fake: Harness.HarnessAdapter = {
  id: "fakecli",
  binary: "fakecli",
  conversation: "assigned",
  rulesInPrompt: false,
  interruptKey: "esc",
  delivery: "type",
  reportsReady: false,
  checkProvider: () => undefined,
  // A per-session config directory under scratch: how a plugin harness loads its own integration for one session.
  launchArgs: (i) => ["--session", i.sessionId!, "--config", `${i.scratch}/fakecli`, "--rules", i.rulesFile],
  models: { args: () => ["models"], answer: () => [{ model: "m", default: true }] },
}

const plugin = Plugin.define({ id: "harness-fakecli", effect: (ctx) => ctx.harness.register(fake) })

it.effect("a plugin harness is spawned by its id", () =>
  Effect.gen(function* () {
    const repo = yield* makeRepository
    const db = yield* Db
    const key = yield* repositoryKey(repo)
    yield* db.coordinatorLaunch(key, "pi", false, { runtime: RUNTIME, address: { machine: "local", id: "test/coord" } })
    const { id } = yield* (yield* Sessions).spawn({
      machine: { id: "local" },
      root: repo,
      key,
      name: "task",
      prompt: "do it",
      harness: "fakecli",
    })
    yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
    const row = (yield* db.getSession(id))!
    assert.strictEqual(row.harnessId, "fakecli")
    const open = (yield* (yield* FakeRuntime).callsTo("open")).at(-1)!
    assert.strictEqual(open.argv[0], "fakecli")
    assert.deepStrictEqual(open.argv.slice(1, 3), ["--session", row.harnessSessionId!])
  }).pipe(Effect.provide(testLayer({ plugins: [plugin] }))),
)
