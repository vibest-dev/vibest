import { assert, describe, it } from "@effect/vitest"
import { callerHits, callerKeys } from "@vibest/core/caller"
import { layer as builtinHarnesses } from "@vibest/core/harnesses"
import { Layout } from "@vibest/core/paths"
import { PluginLoader, type Candidate } from "@vibest/core/plugins"
import { Plugin } from "@vibest/plugin"
import type { Host } from "@vibest/server/daemon"
import { Cause, ConfigProvider, Effect, Exit, FileSystem, Layer, Path } from "effect"
import { Command } from "effect/cli"

import * as Platform from "#platform"

import { callerPlugins, command, mainPlace } from "../src/cli.ts"
import { makeRepository } from "./fakes.ts"

const runtime = (kind: string, priority: number, env: ReadonlyArray<string>): Candidate => ({
  source: kind,
  revision: "-",
  options: {},
  plugin: Plugin.define({
    id: `runtime-${kind}`,
    caller: {
      kind,
      env,
      priority,
      terminal: (values) => Effect.succeed(env.map((key) => values[key]).join("/")),
    },
    effect: () => Effect.void,
  }),
})

const plugins = [
  runtime("hc", 0, ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"]),
  runtime("herdr", 1, ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"]),
  runtime("rex", -1, ["REX_PANE"]),
]

const ternSource = `import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"
export default Plugin.define({
  id: "runtime-tern",
  caller: {
    kind: "tern",
    env: ["TERN_ID", "TERN_SOCK"],
    priority: 2,
    terminal: () => Effect.succeed(undefined),
  },
  effect: () => Effect.void,
})
`

describe("caller plugins", () => {
  it.effect("a third runtime plugin is selected by the priority it declares", () =>
    Effect.gen(function* () {
      const hits = yield* callerHits(plugins, {
        REX_PANE: "rex-9",
        HC_TERMINAL_ID: "t1",
        HC_TERMINAL_SOCKET: "/hc.sock",
        HERDR_PANE_ID: "p1",
        HERDR_SOCKET_PATH: "/herdr.sock",
      })
      assert.deepStrictEqual(mainPlace({ marked: false, runtime: undefined, hits }), {
        in: "terminal",
        runtime: "rex",
        terminal: "rex-9",
      })
    }),
  )

  it.effect("without that plugin's environment the next declared priority wins", () =>
    Effect.gen(function* () {
      const hits = yield* callerHits(plugins, {
        HC_TERMINAL_ID: "t1",
        HC_TERMINAL_SOCKET: "/hc.sock",
        HERDR_PANE_ID: "p1",
        HERDR_SOCKET_PATH: "/herdr.sock",
      })
      assert.deepStrictEqual(mainPlace({ marked: false, runtime: undefined, hits }), {
        in: "terminal",
        runtime: "hc",
        terminal: "t1//hc.sock",
      })
    }),
  )

  it.effect("an empty declared variable is not that runtime", () =>
    Effect.gen(function* () {
      const hits = yield* callerHits(plugins, { REX_PANE: "", HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/hc.sock" })
      assert.strictEqual(mainPlace({ marked: false, runtime: undefined, hits }).in === "terminal", true)
      const place = mainPlace({ marked: false, runtime: undefined, hits })
      assert.strictEqual(place.in === "terminal" ? place.runtime : "", "hc")
    }),
  )

  it.effect("terminal() runs only for the priority winner, or the runtime --runtime names", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const watch = (
        kind: string,
        priority: number,
        env: ReadonlyArray<string>,
        terminal: string,
        fail = false,
      ): Candidate => ({
        source: kind,
        revision: "-",
        options: {},
        plugin: Plugin.define({
          id: kind,
          caller: {
            kind,
            env,
            priority,
            terminal: () => {
              calls.push(kind)
              return fail ? Effect.fail(`${kind} down`) : Effect.succeed(terminal)
            },
          },
          effect: () => Effect.void,
        }),
      })
      const env = {
        HC_TERMINAL_ID: "t1",
        HC_TERMINAL_SOCKET: "/hc.sock",
        HERDR_PANE_ID: "p1",
        HERDR_SOCKET_PATH: "/herdr.sock",
      }
      const hits = yield* callerHits(
        [
          watch("hc", 0, ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"], "hc-term"),
          watch("herdr", 1, ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"], "herdr-term", true),
        ],
        env,
      )
      assert.deepStrictEqual(calls, ["hc"])
      assert.deepStrictEqual(mainPlace({ marked: false, runtime: undefined, hits }), {
        in: "terminal",
        runtime: "hc",
        terminal: "hc-term",
      })
      calls.length = 0
      const named = yield* callerHits(
        [
          watch("hc", 0, ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"], "hc-term", true),
          watch("herdr", 1, ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"], "herdr-term"),
        ],
        env,
        "herdr",
      )
      assert.deepStrictEqual(calls, ["herdr"])
      assert.deepStrictEqual(mainPlace({ marked: false, runtime: "herdr", hits: named }), {
        in: "terminal",
        runtime: "herdr",
        terminal: "herdr-term",
      })
    }),
  )

  it.live("a runtime plugin from vibest.json is detected, and its environment keys join the caller keys", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const base = path.join(import.meta.dirname, ".tmp")
      yield* fs.makeDirectory(base, { recursive: true })
      const dir = yield* fs.makeTempDirectoryScoped({ directory: base })
      yield* fs.writeFileString(path.join(dir, "tern.ts"), ternSource)
      yield* fs.writeFileString(path.join(dir, "vibest.json"), '{ "plugins": ["./tern.ts"] }\n')
      const hc = runtime("hc", 0, ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"])
      const loaded = yield* callerPlugins([hc]).pipe(
        Effect.provideService(PluginLoader, Platform.plugins),
        Effect.provide(Layer.effect(Layout, Layout.make(dir))),
      )
      assert.deepStrictEqual(callerKeys(loaded), ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "TERN_ID", "TERN_SOCK"])
      const repo = yield* makeRepository.pipe(Effect.provide(Platform.services))
      const back = process.cwd()
      process.chdir(repo)
      const host = { builtinPlugins: [hc], plugins: Platform.plugins } as unknown as Host
      const exit = yield* Command.runWith(
        command(host, () => {}),
        { version: "0.0.0-test" },
      )(["--in-parent", repo, "--runtime", "tern"]).pipe(
        Effect.provide(Layer.effect(Layout, Layout.make(dir))),
        Effect.provideService(PluginLoader, Platform.plugins),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              HOME: dir,
              TERN_ID: "t9",
              TERN_SOCK: "/tern.sock",
            }),
          ),
        ),
        Effect.exit,
        Effect.ensuring(Effect.sync(() => process.chdir(back))),
      )
      const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "started"
      assert.match(message, /this tern terminal could not be named/)
      assert.notMatch(message, /environment is not set/)
    }).pipe(Effect.provide(builtinHarnesses), Effect.provide(Platform.services)),
  )
})
