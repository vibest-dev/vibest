import { assert, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Plugins } from "@vibest/core/plugins"
import { Runtimes } from "@vibest/core/runtimes"
import { Sessions } from "@vibest/core/sessions"
import { choicePlugin } from "@vibest/runtime-herdr/choice"
import { Effect } from "effect"

import { FakeRuntime, makeRepository, projectOf, testLayer } from "./fakes.ts"

it.effect("runtime choice: explicit, configured, parent (even offline), then the outside default", () =>
  Effect.gen(function* () {
    for (const [explicit, configured, parent, expected] of [
      ["explicit", "configured", "parent", "explicit"],
      [undefined, "configured", "parent", "configured"],
      [undefined, undefined, "parent", "parent"],
      [undefined, "offline-configured", undefined, "offline-configured"],
      [undefined, undefined, undefined, "herdr"],
    ]) {
      const plugins = yield* Plugins.make([
        { source: "test:choice", revision: "1", options: {}, plugin: choicePlugin(() => Effect.succeed(configured)) },
      ])
      const choice = yield* plugins.start({
        project: "/repo",
        agentType: "main",
        parentSessionId: undefined,
        harnesses: [],
        attempts: [],
        prompt: "",
        harness: undefined,
        provider: undefined,
        model: undefined,
        machine: { id: "local" },
        runtime: explicit,
        parentRuntime: parent,
        machines: [],
      })
      assert.strictEqual(choice.runtime, expected)
    }
  }).pipe(Effect.provide(testLayer())),
)

it.effect(
  "a coordinator is a parent too: its subagent uses its runtime, even when that runtime's default endpoint is offline",
  () =>
    Effect.gen(function* () {
      const fake = (yield* FakeRuntime).runtime
      yield* (yield* Runtimes).register({
        ...fake,
        kind: "other",
        status: () => Effect.succeed({ status: "offline", reason: "default endpoint absent" }),
        process: () => Effect.succeed({ running: true }),
      })
      const db = yield* Db
      const root = yield* makeRepository
      const projectId = yield* projectOf(root)
      const main = yield* db.coordinatorLaunch(projectId, "pi", false, {
        runtime: "other",
        address: { machine: "local", id: "other/main" },
      })
      const child = yield* (yield* Sessions).spawn({
        root,
        projectId,
        name: "child",
        prompt: "test",
        harness: "pi",
        machine: { id: "local" },
        parentSessionId: main.sessionId,
      })
      assert.strictEqual((yield* db.getSession(child.id))?.runtime, "other")
    }).pipe(Effect.provide(testLayer())),
)
