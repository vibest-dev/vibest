import { assert, describe, it } from "@effect/vitest"
import { callerHits, callerKeys } from "@vibest/core/caller"
import { layer as builtinHarnesses } from "@vibest/core/harnesses"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { PluginLoader, type Candidate } from "@vibest/core/plugins"
import { Plugin } from "@vibest/plugin"
import { run as runDaemon, type Host } from "@vibest/server/daemon"
import { Cause, ConfigProvider, Effect, Exit, FileSystem, Layer, Logger, Path } from "effect"
import { Command } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

import { callerPlugins, command, mainPlace } from "../src/cli.ts"
import { makeRepository } from "./fakes.ts"

const runtime = (kind: string, env: ReadonlyArray<string>): Candidate => ({
  source: kind,
  revision: "-",
  options: {},
  plugin: Plugin.define({
    id: `runtime-${kind}`,
    caller: {
      kind,
      env,
      terminal: (values) => Effect.succeed(env.map((key) => values[key]).join("/")),
    },
    effect: () => Effect.void,
  }),
})

const plugins = [
  runtime("hc", ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"]),
  runtime("herdr", ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"]),
  runtime("rex", ["REX_PANE"]),
]

const ternSource = `import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"
export default Plugin.define({
  id: "runtime-tern",
  caller: {
    kind: "tern",
    env: ["TERN_ID", "TERN_SOCK"],
    terminal: () => Effect.succeed(undefined),
  },
  effect: () => Effect.void,
})
`

describe("caller plugins", () => {
  it.effect("the first detected plugin in load order wins", () =>
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
        runtime: "hc",
        terminal: "t1//hc.sock",
      })
    }),
  )

  it.effect("hc's variables win over herdr's even when herdr is loaded first", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const watch = (
        kind: string,
        env: ReadonlyArray<string>,
        terminal: string,
        overOtherCallers = false,
      ): Candidate => ({
        source: kind,
        revision: "-",
        options: {},
        plugin: Plugin.define({
          id: kind,
          caller: {
            kind,
            env,
            ...(overOtherCallers ? { overOtherCallers: true } : {}),
            terminal: () => {
              calls.push(kind)
              return Effect.succeed(terminal)
            },
          },
          effect: () => Effect.void,
        }),
      })
      const loaded = [
        watch("herdr", ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"], "herdr-term"),
        watch("hc", ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"], "hc-term", true),
        watch("rex", ["REX_PANE"], "rex-term"),
      ]
      const env = {
        REX_PANE: "rex-9",
        HC_TERMINAL_ID: "t1",
        HC_TERMINAL_SOCKET: "/hc.sock",
        HERDR_PANE_ID: "p1",
        HERDR_SOCKET_PATH: "/herdr.sock",
      }
      const hits = yield* callerHits(loaded, env)
      assert.deepStrictEqual(calls, ["hc"])
      assert.deepStrictEqual(mainPlace({ marked: false, runtime: undefined, hits }), {
        in: "terminal",
        runtime: "hc",
        terminal: "hc-term",
      })
      calls.length = 0
      const named = yield* callerHits(loaded, env, "herdr")
      assert.deepStrictEqual(calls, ["herdr"])
      assert.deepStrictEqual(mainPlace({ marked: false, runtime: "herdr", hits: named }), {
        in: "terminal",
        runtime: "herdr",
        terminal: "herdr-term",
      })
    }),
  )

  it.effect("without an earlier plugin's environment the next one in load order wins", () =>
    Effect.gen(function* () {
      const hits = yield* callerHits(plugins, {
        REX_PANE: "rex-9",
        HERDR_PANE_ID: "p1",
        HERDR_SOCKET_PATH: "/herdr.sock",
      })
      assert.deepStrictEqual(mainPlace({ marked: false, runtime: undefined, hits }), {
        in: "terminal",
        runtime: "herdr",
        terminal: "p1//herdr.sock",
      })
    }),
  )

  it.effect("an empty declared variable is not that runtime", () =>
    Effect.gen(function* () {
      const hits = yield* callerHits(plugins, { REX_PANE: "", HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/hc.sock" })
      const place = mainPlace({ marked: false, runtime: undefined, hits })
      assert.strictEqual(place.in === "terminal" ? place.runtime : "", "hc")
    }),
  )

  it.effect("a caller without a string kind, an env array, and a terminal function is skipped", () =>
    Effect.gen(function* () {
      const loose = (id: string, caller: object): Candidate => ({
        source: id,
        revision: "-",
        options: {},
        plugin: Plugin.define({
          id,
          caller: caller as Plugin.Caller,
          effect: () => Effect.void,
        }),
      })
      const hits = yield* callerHits(
        [
          loose("no-kind", { env: ["TERN_ID"], terminal: () => Effect.succeed("t") }),
          loose("bad-env", { kind: "tern", env: "TERN_ID", terminal: () => Effect.succeed("t") }),
          loose("no-terminal", { kind: "tern", env: ["TERN_ID"] }),
          runtime("hc", ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"]),
        ],
        { TERN_ID: "t9", HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/hc.sock" },
      )
      assert.deepStrictEqual(
        hits.map((hit) => hit.kind),
        ["hc"],
      )
    }),
  )

  it.effect("terminal() runs only for the first detected runtime, or the runtime --runtime names", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const watch = (kind: string, env: ReadonlyArray<string>, terminal: string, fail = false): Candidate => ({
        source: kind,
        revision: "-",
        options: {},
        plugin: Plugin.define({
          id: kind,
          caller: {
            kind,
            env,
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
          watch("hc", ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"], "hc-term"),
          watch("herdr", ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"], "herdr-term", true),
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
          watch("hc", ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"], "hc-term", true),
          watch("herdr", ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"], "herdr-term"),
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

  it.live("a runtime plugin from vibest.json is detected, and its environment keys join the caller keys", () => {
    const logs: Array<string> = []
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const base = path.join(import.meta.dirname, ".tmp")
      yield* fs.makeDirectory(base, { recursive: true })
      const dir = yield* fs.makeTempDirectoryScoped({ directory: base })
      yield* fs.writeFileString(path.join(dir, "tern.ts"), ternSource)
      yield* fs.writeFileString(
        path.join(dir, "vibest.json"),
        '{ "runtime": "rex", "plugins": ["./tern.ts", "./not-a-plugin"] }\n',
      )
      const hc = runtime("hc", ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"])
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
      assert.deepStrictEqual(
        logs.filter((line) => /runtime|plugin|vibest\.json/i.test(line)),
        [],
      )
    }).pipe(
      Effect.provide(Logger.layer([Logger.make((entry) => void logs.push(String(entry.message)))])),
      Effect.provide(builtinHarnesses),
      Effect.provide(Platform.services),
    )
  })

  it("builtin plugins list herdr-core before herdr", () => {
    const sources = Platform.daemon.builtinPlugins.map((plugin) => plugin.source)
    const hc = sources.indexOf("builtin:runtime-herdr-core")
    const herdr = sources.indexOf("builtin:runtime-herdr")
    assert.ok(hc >= 0 && herdr > hc)
    const callerOf = (source: string) => {
      const plugin = Platform.daemon.builtinPlugins.find((candidate) => candidate.source === source)?.plugin
      return plugin !== undefined && "caller" in plugin ? plugin.caller : undefined
    }
    assert.strictEqual(callerOf("builtin:runtime-herdr-core")?.overOtherCallers, true)
    assert.notStrictEqual(callerOf("builtin:runtime-herdr")?.overOtherCallers, true)
  })

  it.live("a user runtime env key does not reach a process vibestd starts", () =>
    Effect.gen(function* () {
      const key = "VIBEST_USER_RUNTIME_ID"
      const previous = process.env[key]
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env[key]
          else process.env[key] = previous
        }),
      )
      process.env[key] = "leaked"
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const base = path.join(import.meta.dirname, ".tmp")
      yield* fs.makeDirectory(base, { recursive: true })
      const dir = yield* fs.makeTempDirectoryScoped({ directory: base })
      yield* fs.makeDirectory(path.join(dir, "plugins"))
      const host: Host = { ...Platform.daemon, builtinPlugins: [runtime("user", [key])] }
      const layout = yield* Layout.make(dir)
      yield* runDaemon(host).pipe(
        Effect.provideService(Layout, layout),
        Effect.provideService(VibestCommand, ["/bin/vibest"]),
        Effect.provide(builtinHarnesses),
        Effect.forkScoped,
      )
      yield* Effect.gen(function* () {
        while (process.env[key] !== undefined) yield* Effect.sleep("20 millis")
      }).pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die("caller env was not dropped") }))
      const out = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).string(
        ChildProcess.make("sh", ["-c", `printf %s "\${${key}-}"`]),
      )
      assert.strictEqual(out, "")
    }).pipe(Effect.provide(Platform.services)),
  )
})
