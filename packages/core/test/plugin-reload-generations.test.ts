import { assert, describe, it } from "@effect/vitest"
import { Agents } from "@vibest/core/agents"
import { Bus } from "@vibest/core/bus"
import { Layout } from "@vibest/core/paths"
import { Builtins, type Candidate, PluginLoader, Plugins } from "@vibest/core/plugins"
import { Plugin } from "@vibest/plugin"
import { Context, Effect, Fiber, FileSystem, Layer, Path } from "effect"
import { TestClock } from "effect/testing"

import * as Platform from "../../platform-bun/src/bun.ts"
import { harnessesLayer, runtimesLayer, subscriptionsLayer } from "./lib/harnesses.ts"

const events: Array<string> = []
const builtin: Candidate = {
  source: "builtin:harness-x",
  revision: "1",
  options: {},
  plugin: Plugin.define({
    id: "harness-x",
    effect: (ctx) =>
      Effect.gen(function* () {
        events.push("setup")
        yield* Effect.addFinalizer(() => Effect.sync(() => events.push("close")))
        yield* ctx.agent.hook("start.before", () => Effect.void)
      }),
  }),
}

const plugin = (id: string) => `// gate:${id}
import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"
export default Plugin.define({ id: "${id}", effect: () => Effect.void })
`

const event = {
  project: "/r",
  agent: "general",
  parentSessionId: undefined,
  prompt: "p",
  harness: undefined,
  provider: undefined,
  model: undefined,
  machine: { id: "local" },
  runtime: undefined,
  parentRuntime: undefined,
  machines: [],
  attempts: [],
  harnesses: [],
}

const until = Effect.fn("until")(function* (what: string, done: () => boolean) {
  for (let i = 0; i < 250 && !done(); i++) {
    yield* TestClock.withLive(Effect.sleep("20 millis"))
    yield* TestClock.adjust("150 millis")
  }
  if (!done()) return yield* Effect.die(`gave up waiting for ${what}`)
})

describe("plugins: builtins follow the latest config", () => {
  it.effect(
    "a removal that arrives while user plugins are still importing takes the builtin off at once, so a start does not run it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ directory: import.meta.dirname, prefix: ".tmp-" }),
        )
        yield* fs.makeDirectory(path.join(dir, "plugins"))
        const config = path.join(dir, "vibest.json")
        let release!: () => void
        const gate = new Promise<void>((resolve) => (release = resolve))
        const entered = new Set<string>()
        const platform = Platform.makePluginLoader()
        const loader: PluginLoader["Service"] = {
          ...platform,
          prepare: Effect.void,
          load: async (entry, files) => {
            const name = /gate:(\w+)/.exec(await Bun.file(entry).text())?.[1]
            if (name !== undefined) {
              entered.add(name)
              await gate
            }
            return platform.load(entry, files)
          },
        }
        yield* fs.writeFileString(config, `{ "plugins": ["-harness-x"] }`)
        const plugins = yield* Plugins.layer.pipe(
          Layer.provide(Layer.succeed(PluginLoader, loader)),
          Layer.provide(Layer.succeed(Builtins, [builtin])),
          Layer.provide(subscriptionsLayer),
          Layer.provide(harnessesLayer()),
          Layer.provide(Layer.effect(Layout, Layout.make(dir))),
          Layer.provide(runtimesLayer),
          Layer.provide(Agents.layer),
          Layer.provide(Bus.layer),
          Layer.build,
          Effect.map(Context.get(Plugins)),
        )
        assert.deepStrictEqual(events, [])

        yield* fs.writeFileString(config, `{ "plugins": [] }`)
        yield* fs.writeFileString(path.join(dir, "plugins", "slow.ts"), plugin("slow"))
        yield* until("the slow import", () => entered.has("slow"))
        yield* until("the restored builtin", () => events.at(-1) === "setup")

        yield* fs.writeFileString(config, `{ "plugins": ["-harness-x"] }`)
        yield* until("the removal", () => events.at(-1) === "close")

        const spawning = yield* Effect.forkChild(plugins.start(event))
        yield* TestClock.adjust("6 seconds")
        yield* TestClock.adjust("300 millis")
        const decision = yield* TestClock.withLive(Fiber.join(spawning).pipe(Effect.timeout("15 seconds")))
        assert.isFalse(
          decision.trace.some((t) => t.plugin === "harness-x"),
          "the removed builtin ran",
        )
        release()
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    { timeout: 20_000 },
  )
})
