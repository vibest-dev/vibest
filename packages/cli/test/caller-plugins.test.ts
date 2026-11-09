import { assert, describe, it } from "@effect/vitest"
import { callerHits, callerKeys, callerTarget, mainPlace, type CallerHit } from "@vibest/core/caller"
import { layer as builtinHarnesses } from "@vibest/core/harnesses"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { makeSources } from "@vibest/core/plugin-sources"
import { DEFAULT_TIMEOUT, PluginLoader, type Candidate } from "@vibest/core/plugins"
import { Plugin } from "@vibest/plugin"
import { run as runDaemon, type Host } from "@vibest/server/daemon"
import { Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

const callerPlugins = (builtins: ReadonlyArray<Candidate>) =>
  Effect.gen(function* () {
    const loader = yield* PluginLoader
    yield* loader.prepare
    const read = yield* (yield* makeSources(DEFAULT_TIMEOUT, { quiet: true })).read
    return [...builtins, ...read.candidates]
  })

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

describe("where the main agent runs", () => {
  const hc = { kind: "hc", terminal: "t4@/run/hc/default.sock" } satisfies CallerHit
  const herdr = { kind: "herdr", terminal: "vibest/p1" } satisfies CallerHit
  it("no detected runtime is refused, and --runtime launches one", () => {
    const refused = mainPlace({ runtime: undefined, hits: [] })
    assert.strictEqual(refused.in, "refused")
    assert.match(refused.in === "refused" ? refused.message : "", /pass --runtime/)
    assert.deepStrictEqual(mainPlace({ runtime: "herdr", hits: [] }), {
      in: "launch",
      runtime: "herdr",
    })
  })
  it("one detected runtime starts the main agent in that terminal", () => {
    assert.deepStrictEqual(mainPlace({ runtime: undefined, hits: [hc] }), {
      in: "terminal",
      runtime: "hc",
      terminal: hc.terminal,
    })
    assert.deepStrictEqual(mainPlace({ runtime: undefined, hits: [herdr] }), {
      in: "terminal",
      runtime: "herdr",
      terminal: herdr.terminal,
    })
    assert.strictEqual(mainPlace({ runtime: undefined, hits: [{ ...herdr, terminal: undefined }] }).in, "refused")
  })
  it("two detected runtimes follow load order, and --runtime overrides", () => {
    assert.deepStrictEqual(mainPlace({ runtime: undefined, hits: [hc, herdr] }), {
      in: "terminal",
      runtime: "hc",
      terminal: hc.terminal,
    })
    assert.deepStrictEqual(mainPlace({ runtime: undefined, hits: [herdr, hc] }), {
      in: "terminal",
      runtime: "herdr",
      terminal: herdr.terminal,
    })
    assert.deepStrictEqual(mainPlace({ runtime: "herdr", hits: [herdr, hc] }), {
      in: "terminal",
      runtime: "herdr",
      terminal: herdr.terminal,
    })
    assert.deepStrictEqual(mainPlace({ runtime: "hc", hits: [herdr] }), {
      in: "launch",
      runtime: "hc",
    })
  })
})

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
      assert.deepStrictEqual(mainPlace({ runtime: undefined, hits }), {
        in: "terminal",
        runtime: "hc",
        terminal: "t1//hc.sock",
      })
    }),
  )

  it.effect("builtin plugins choose hc when both environments are set, and --runtime herdr names herdr", () =>
    Effect.gen(function* () {
      const builtins = Platform.daemon.builtinPlugins.map((candidate) => {
        const plugin = candidate.plugin
        if (!("caller" in plugin) || plugin.caller?.kind !== "herdr") return candidate
        return {
          ...candidate,
          plugin: Plugin.define({
            id: plugin.id,
            caller: { ...plugin.caller, terminal: () => Effect.succeed("herdr-term") },
            effect: plugin.effect,
          }),
        }
      })
      const env = {
        HC_TERMINAL_ID: "t1",
        HC_TERMINAL_SOCKET: "/hc.sock",
        HERDR_PANE_ID: "p1",
        HERDR_SOCKET_PATH: "/herdr.sock",
      }
      const hits = yield* callerHits(builtins, env)
      assert.deepStrictEqual(mainPlace({ runtime: undefined, hits }), {
        in: "terminal",
        runtime: "hc",
        terminal: "t1@/hc.sock",
      })
      const named = yield* callerHits(builtins, env, "herdr")
      assert.deepStrictEqual(mainPlace({ runtime: "herdr", hits: named }), {
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
      assert.deepStrictEqual(mainPlace({ runtime: undefined, hits }), {
        in: "terminal",
        runtime: "herdr",
        terminal: "p1//herdr.sock",
      })
    }),
  )

  it.effect("an empty declared variable is not that runtime", () =>
    Effect.gen(function* () {
      const hits = yield* callerHits(plugins, { REX_PANE: "", HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/hc.sock" })
      const place = mainPlace({ runtime: undefined, hits })
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
      assert.deepStrictEqual(mainPlace({ runtime: undefined, hits }), {
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
      assert.deepStrictEqual(mainPlace({ runtime: "herdr", hits: named }), {
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
    }).pipe(Effect.provide(Platform.services)),
  )

  it("callerTarget uses the socket path, a named session, or no target, and a plugin never sees keys it did not declare", () => {
    const seen: Array<Record<string, string | undefined>> = []
    const herdr = {
      env: ["HERDR_SOCKET_PATH"],
      target: (env: Readonly<Record<string, string | undefined>>, named?: string) => {
        seen.push({ ...env })
        if (named !== undefined) return `session:${named}`
        return env.HERDR_SOCKET_PATH === undefined ? undefined : `socket:${env.HERDR_SOCKET_PATH}`
      },
    }
    const env = { HERDR_SOCKET_PATH: "/h.sock", HERDR_PANE_ID: "p1", OTHER: "x" }
    assert.strictEqual(callerTarget([herdr], env), "socket:/h.sock")
    assert.deepStrictEqual(seen, [{ HERDR_SOCKET_PATH: "/h.sock" }])
    assert.strictEqual(callerTarget([herdr], env, "other"), "session:other")
    assert.strictEqual(callerTarget([herdr], {}), undefined)
    assert.strictEqual(callerTarget([{ env: ["REX_PANE"] }], env), undefined)
  })

  it("builtin plugins list herdr-core before herdr", () => {
    const sources = Platform.daemon.builtinPlugins.map((plugin) => plugin.source)
    const hc = sources.indexOf("builtin:runtime-herdr-core")
    const herdr = sources.indexOf("builtin:runtime-herdr")
    assert.ok(hc >= 0 && herdr > hc)
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
