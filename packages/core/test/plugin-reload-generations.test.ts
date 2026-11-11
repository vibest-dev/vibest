import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Layout } from "@vibest/core/paths"
import { Builtins, type Candidate, PluginLoader, Plugins } from "@vibest/core/plugins"
import { Plugin } from "@vibest/plugin"
import { Context, Effect, FileSystem, Layer, Path, Schedule } from "effect"

import * as Platform from "../../cli/src/platform/bun.ts"
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

const until = (what: string, done: () => boolean) =>
  Effect.void.pipe(
    Effect.repeat({ while: () => !done(), schedule: Schedule.spaced("20 millis"), times: 250 }),
    Effect.filterOrElse(done, () => Effect.die(`gave up waiting for ${what}`)),
  )

describe("plugins: config generations", () => {
  it.live(
    "overlapping config edits during slow imports: only the newest config is in force, so a removed builtin never shows through the 10s fallback",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ directory: import.meta.dirname, prefix: ".tmp-" }),
        )
        yield* fs.makeDirectory(path.join(dir, "plugins"))
        const config = path.join(dir, "vibest.json")
        const gates = new Map<string, { promise: Promise<void>; open: () => void }>()
        for (const name of ["first", "second"]) {
          let open!: () => void
          gates.set(name, { promise: new Promise<void>((resolve) => (open = resolve)), open })
        }
        const entered = new Set<string>()
        const loader: PluginLoader["Service"] = {
          ...Platform.plugins,
          prepare: Effect.void,
          load: async (entry, files) => {
            const name = /gate:(\w+)/.exec(await Bun.file(entry).text())?.[1]
            if (name !== undefined) {
              entered.add(name)
              await gates.get(name)?.promise
            }
            return Platform.plugins.load(entry, files)
          },
        }
        yield* fs.writeFileString(config, `{ "plugins": ["-harness-x"] }`)
        yield* Plugins.layer.pipe(
          Layer.provide(Layer.succeed(PluginLoader, loader)),
          Layer.provide(Layer.succeed(Builtins, [builtin])),
          Layer.provide(subscriptionsLayer),
          Layer.provide(harnessesLayer()),
          Layer.provide(Layer.effect(Layout, Layout.make(dir))),
          Layer.provide(runtimesLayer),
          Layer.provide(Bus.layer),
          Layer.build,
          Effect.map(Context.get(Plugins)),
        )
        assert.deepStrictEqual(events, [])

        yield* fs.writeFileString(config, `{ "plugins": [] }`)
        yield* fs.writeFileString(path.join(dir, "plugins", "first.ts"), plugin("first"))
        yield* until("the first slow import", () => entered.has("first"))
        yield* until("the builtin restored", () => events.at(-1) === "setup")

        yield* fs.writeFileString(config, `{ "plugins": ["-harness-x"] }`)
        yield* fs.writeFileString(path.join(dir, "plugins", "second.ts"), plugin("second"))
        yield* Effect.sleep("300 millis")
        gates.get("first")?.open()
        yield* until("the second slow import", () => entered.has("second"))

        assert.strictEqual(events.at(-1), "close", `the removed builtin runs while the newest config loads: ${events}`)
        gates.get("second")?.open()
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    { timeout: 20_000 },
  )
})
