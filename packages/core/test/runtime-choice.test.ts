import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import type { LayerNode } from "@vibest/core/effect/layer-node"
import { Sessions } from "@vibest/core/sessions"
import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"

import { projectOf } from "./lib/directory.ts"
import { testEffect } from "./lib/effect.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { makeRepository, pluginsHost, runtimeNode, sessionLayer } from "./lib/session.ts"

const test = <E, R>(
  name: string,
  program: Effect.Effect<void, E, R>,
  replacements: LayerNode.Replacements = [],
  plugins?: ReturnType<typeof pluginsHost>,
) => testEffect(sessionLayer(replacements, plugins))(name, () => program)

const input = (
  repo: string,
  projectId: string,
  extra: { readonly runtime?: string; readonly parentSessionId?: string } = {},
) => ({
  machine: { id: "local" as const },
  root: repo,
  parentSessionId: "creator",
  projectId,
  name: "task",
  prompt: "do it",
  harness: "pi" as const,
  ...extra,
})

const entryId = Effect.gen(function* () {
  const db = yield* Db
  const repo = yield* makeRepository
  const projectId = yield* projectOf(repo)
  const entry = yield* db.startEntry(projectId, "pi", false, {
    runtime: "herdr",
    address: { machine: "local", id: "test/coord" },
  })
  return { db, repo, projectId, sessions: yield* Sessions, parent: entry.sessionId }
})

describe("subagent runtime", () => {
  test(
    "a subagent of the entry session inherits the entry session runtime",
    Effect.gen(function* () {
      const { repo, projectId, sessions, parent } = yield* entryId
      const spawned = yield* sessions.spawn(input(repo, projectId, { parentSessionId: parent }))
      assert.strictEqual(spawned.runtime, "herdr")
      assert.strictEqual(spawned.decidedBy.runtime, "runtime-choice")
    }),
  )

  test(
    "--runtime overrides the parent runtime",
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)
      const entry = yield* db.startEntry(projectId, "pi", false, {
        runtime: "hc",
        address: { machine: "local", id: "test/coord" },
      })
      const spawned = yield* (yield* Sessions).spawn(
        input(repo, projectId, { parentSessionId: entry.sessionId, runtime: "herdr" }),
      )
      assert.strictEqual(spawned.runtime, "herdr")
      assert.strictEqual(spawned.decidedBy.runtime, undefined)
    }),
  )

  test(
    "an offline parent runtime refuses the start with the runtime's reason",
    Effect.gen(function* () {
      const { repo, projectId, sessions, parent } = yield* entryId
      const error = yield* Effect.flip(sessions.spawn(input(repo, projectId, { parentSessionId: parent })))
      assert.strictEqual(error._tag, "NoRuntime")
      assert.match("message" in error ? error.message : "", /herdr is offline \(not running\)/)
    }),
    [runtimeNode.replace(FakeRuntime.layer({ offline: "not running" }))],
  )

  test(
    "a user plugin can still set the runtime when nothing else did",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const spawned = yield* (yield* Sessions).spawn(input(repo, yield* projectOf(repo)))
      assert.strictEqual(spawned.runtime, "herdr")
      assert.strictEqual(spawned.decidedBy.runtime, "pick")
    }),
    [],
    pluginsHost([
      Plugin.define({
        id: "pick",
        effect: (ctx) => ctx.agent.hook("start.before", () => Effect.succeed({ runtime: "herdr" })),
      }),
    ]),
  )
})
