import { assert, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Plugins } from "@vibest/core/plugins"
import { Runtimes } from "@vibest/core/runtimes"
import { Sessions } from "@vibest/core/sessions"
import { choicePlugin } from "@vibest/runtime-herdr/choice"
import { Effect, FileSystem } from "effect"

import { FakeRuntime, makeRepository, projectOf, testLayer } from "./fakes.ts"

it.effect("runtime choice: explicit or plugin, online parent, then the outside default", () =>
  Effect.gen(function* () {
    const fake = (yield* FakeRuntime).runtime
    const runtimes = yield* Runtimes
    yield* runtimes.register({ ...fake, kind: "parent" })
    yield* runtimes.register({
      ...fake,
      kind: "offline",
      status: () => Effect.succeed({ status: "offline", reason: "absent" }),
    })
    for (const [explicit, parent, expected] of [
      ["explicit", "parent", "explicit"],
      [undefined, "parent", "parent"],
      [undefined, "offline", "herdr"],
      [undefined, undefined, "herdr"],
    ]) {
      const plugins = yield* Plugins.make([
        { source: "test:choice", revision: "1", options: {}, plugin: choicePlugin() },
      ])
      const choice = yield* plugins.start({
        project: "/repo",
        agentType: "general",
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
  "an obsolete runtime config cannot pull a subagent away from its coordinator, even when the parent default endpoint is offline",
  () =>
    Effect.gen(function* () {
      const fake = (yield* FakeRuntime).runtime
      yield* (yield* Runtimes).register({
        ...fake,
        kind: "other",
        status: () => Effect.succeed({ status: "offline", reason: "default endpoint absent" }),
        process: () => Effect.succeed({ running: true }),
      })
      yield* (yield* FileSystem.FileSystem).writeFileString(
        (yield* Layout).config,
        JSON.stringify({ runtime: "herdr" }),
      )
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
