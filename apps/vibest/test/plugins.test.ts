// Plugins (plugins.md §6): finding and loading from VIBEST_HOME, and the spawn hook's rules through Sessions.spawn.
import { assert, describe, it } from "@effect/vitest"
import { Layout } from "@vibest/core/paths"
import { AgentRefused, Builtins, pluginEntries, PluginLoader, Plugins } from "@vibest/core/plugins"
import { Runtimes } from "@vibest/core/runtimes"
import { Sessions } from "@vibest/core/sessions"
import { Storage } from "@vibest/core/storage"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { AgentRefused as PluginRefused, Plugin, type AgentStartBefore } from "@vibest/plugin"
import { mainCheckout, repositoryKey } from "@vibest/vibest/worktree"
import { Context, Effect, Fiber, FileSystem, Layer, Path, type Scope } from "effect"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import {
  FakeRuntime,
  makeRepository,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
  harnessChoice,
} from "./fakes.ts"

const spawnInput = (repo: string, extra: { harness?: "pi" | "claude"; model?: string; prompt?: string } = {}) =>
  Effect.map(repositoryKey(repo), (key) => ({
    machine: { id: "local" },
    root: repo,
    key,
    name: "task",
    prompt: extra.prompt ?? "do it",
    ...extra,
  }))

const hook = (id: string, callback: (e: AgentStartBefore) => Effect.Effect<void, PluginRefused>) =>
  Plugin.define({ id, effect: (ctx) => ctx.agent.hook("start.before", callback) })
const write = (id: string, f: (e: AgentStartBefore) => void) => hook(id, (e) => Effect.sync(() => f(e)))

/** Models the plugins below route to; Spawn checks the harness lists them. */
const PLUGIN_MODELS = ["claude-haiku-5-5", "a", "b", "two", "after", "m"]

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>, options?: TestOptions) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer({ models: PLUGIN_MODELS, ...options }))))

/** The session count in db and herdr after a refused or failed spawn. */
const sessionCount = Effect.gen(function* () {
  const db = yield* Storage
  const herdr = yield* FakeRuntime
  return { rows: (yield* db.listSessions()).length, starts: (yield* herdr.callsTo("open")).length }
})

describe("plugins: spawn hook", () => {
  test(
    "P5/P8: the event has the resolved root; writes reach the row and the launch args",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const db = yield* Storage
      const herdr = yield* FakeRuntime
      const nested = `${repo}/sub`
      yield* (yield* FileSystem.FileSystem).makeDirectory(nested)
      // Server resolves the main checkout before Spawn, as here.
      const s = yield* (yield* Sessions).spawn(
        yield* spawnInput(yield* mainCheckout(nested), { prompt: "research: how does the cache work?" }),
      )
      assert.strictEqual(s.harness, "claude")
      assert.strictEqual(s.model, "claude-haiku-5-5")
      assert.deepStrictEqual(s.decidedBy, { harness: "route", runtime: "runtime-choice", model: "route" })
      const row = (yield* db.getSession(s.id))!
      assert.strictEqual(row.harnessId, "claude")
      assert.strictEqual(row.model, "claude-haiku-5-5")
      assert.deepStrictEqual(row.metadata.routing?.decidedBy, {
        harness: "route",
        runtime: "runtime-choice",
        model: "route",
      })
      yield* until(herdr.callsTo("open"), (c) => c.length > 0)
      const args = (yield* herdr.callsTo("open"))[0]!.argv
      assert.include(args.join(" "), "--model claude-haiku-5-5")
    }),
    {
      plugins: [
        hook("route", (e) =>
          Effect.sync(() => {
            assert.strictEqual(e.project.endsWith("/sub"), false)
            if (e.prompt.startsWith("research:")) {
              e.harness = "claude"
              e.model = "claude-haiku-5-5"
            }
          }),
        ),
      ],
    },
  )

  test(
    "P6: the last writer wins and the trace says whom it overwrote",
    Effect.gen(function* () {
      const s = yield* (yield* Sessions).spawn(
        yield* spawnInput(yield* makeRepository, { harness: "pi", model: "requested" }),
      )
      assert.strictEqual(s.model, "b")
      assert.deepStrictEqual(
        s.trace.map((t) => t.changes),
        [
          [],
          [{ field: "runtime", to: "herdr" }],
          [{ field: "model", from: "requested", to: "a" }],
          [{ field: "model", from: "a", to: "b", overwrote: "A" }],
        ],
      )
      assert.deepStrictEqual(s.decidedBy, { runtime: "runtime-choice", model: "B" })
    }),
    { plugins: [write("A", (e) => (e.model = "a")), write("B", (e) => (e.model = "b"))] },
  )

  test(
    "P2: a failing callback is a refusal naming the plugin; nothing is inserted or started",
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository, { harness: "pi" })),
      )
      assert.strictEqual(error._tag, "AgentRefused")
      assert.deepInclude(error, { plugin: "fails", reason: "plugin fails crashed: boom" })
      assert.deepStrictEqual(yield* sessionCount, { rows: 0, starts: 0 })
      const listed = yield* (yield* Plugins).list
      const fails = listed.find((q) => q.id === "fails")!
      const after = listed.find((q) => q.id === "after")!
      assert.strictEqual(fails.crashed, 1)
      assert.include(fails.lastError, "boom")
      assert.strictEqual(after.calls, 0)
    }),
    {
      plugins: [
        hook("fails", () => Effect.fail(new Error("boom") as never)),
        write("after", () => assert.fail("must not run after a crash")),
      ],
    },
  )

  test(
    "P2: a defect is a refusal too, and its partial writes are recorded but never start anything",
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository, { harness: "pi" })),
      )
      assert.deepInclude(error, { _tag: "AgentRefused", plugin: "dies", reason: "plugin dies crashed: defect" })
      assert.deepStrictEqual(yield* sessionCount, { rows: 0, starts: 0 })
    }),
    {
      plugins: [
        hook("dies", (e) => Effect.sync(() => (e.provider = "partial")).pipe(Effect.andThen(Effect.die("defect")))),
      ],
    },
  )

  /** Set when the stuck hook starts, so virtual time moves only once it is waiting. */
  const entered = { value: false }
  for (const [label, stuck] of [
    ["never", Effect.never],
    ["a promise that never settles", Effect.promise(() => new Promise<void>(() => {}))],
    ["a long sleep", Effect.sleep("1 hour")],
    ["an uninterruptible sleep", Effect.uninterruptible(Effect.sleep("1 minute"))],
  ] as const) {
    test(
      `P3: a hook stuck in ${label} times out and refuses the start`,
      Effect.gen(function* () {
        const repo = yield* makeRepository
        entered.value = false
        const spawning = yield* Effect.forkChild((yield* Sessions).spawn(yield* spawnInput(repo, { harness: "pi" })))
        yield* until(
          Effect.sync(() => entered.value),
          (x) => x,
        )
        yield* TestClock.adjust("5 seconds")
        const error = yield* Effect.flip(Fiber.join(spawning))
        assert.strictEqual(error._tag, "AgentRefused")
        assert.deepInclude(error, { plugin: "stuck", reason: "plugin stuck timed out after 5s" })
        assert.deepStrictEqual(yield* sessionCount, { rows: 0, starts: 0 })
        // Past the uninterruptible sleep, so the plugin scope can close at teardown.
        yield* TestClock.adjust("1 minute")
      }),
      {
        plugins: [
          hook("stuck", () => Effect.sync(() => (entered.value = true)).pipe(Effect.andThen(stuck))),
          write("after", () => assert.fail("must not run after a timeout")),
        ],
      },
    )
  }

  it("P9: read-only fields are read-only to plugins at compile time", () => {
    write("readonly", (e) => {
      // @ts-expect-error project is read-only
      e.project = "changed"
    })
  })

  test(
    "a plugin can rewrite the prompt the session receives",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const s = yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository, { harness: "pi" }))
      assert.deepStrictEqual(s.trace.at(-1)!.changes, [
        { field: "prompt", from: "do it", to: "do it\n\nRun the tests first." },
      ])
      yield* until(herdr.callsTo("send"), (c) => c.length > 0)
      assert.include((yield* herdr.callsTo("send"))[0]!.text, "Run the tests first.")
    }),
    { plugins: [write("rules", (e) => (e.prompt += "\n\nRun the tests first."))] },
  )

  test(
    "P8: an unknown harness written by a plugin is refused, naming it",
    Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(yield* makeRepository)))
      assert.strictEqual(error._tag, "HarnessUnavailable")
      assert.include(error.message, "vim")
      assert.include(error.message, "editor")
      assert.deepStrictEqual(yield* sessionCount, { rows: 0, starts: 0 })
    }),
    { plugins: [write("editor", (e) => (e.harness = "vim"))] },
  )

  test(
    "P14: AgentRefused stops at once; nothing is inserted or started",
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository, { harness: "pi" })),
      )
      assert.strictEqual(error._tag, "AgentRefused")
      assert.deepInclude(error, { plugin: "budget", reason: "no opus here" })
      assert.deepStrictEqual(yield* sessionCount, { rows: 0, starts: 0 })
      const listed = yield* (yield* Plugins).list
      assert.strictEqual(listed.find((q) => q.id === "budget")!.refused, 1)
      assert.strictEqual(listed.find((q) => q.id === "after")!.calls, 0)
    }),
    {
      plugins: [
        hook("budget", () => Effect.fail(new PluginRefused({ reason: "no opus here" }))),
        write("after", () => assert.fail("must not run after a rejection")),
      ],
    },
  )

  test(
    "P14: a plugin that unsets the harness leaves NoHarnessChosen",
    Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(yield* makeRepository)))
      assert.strictEqual(error._tag, "NoHarnessChosen")
      assert.include(error.message, "routing plugin")
    }),
    { plugins: [write("none", (e) => (e.harness = undefined))] },
  )

  test(
    "no usable harness at all is a refusal naming each harness",
    Effect.gen(function* () {
      const error = yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository)).pipe(
        Effect.flip,
        Effect.filterOrElse(
          (e): e is AgentRefused => e._tag === "AgentRefused",
          (e) => Effect.die(new Error(`not refused: ${e._tag}`)),
        ),
      )
      assert.deepInclude(error, {
        plugin: "harness-choice",
        reason:
          "no harness available: pi: pi model discovery failed: Not logged in, claude: claude model discovery failed: Not logged in, cursor: cursor model discovery failed: Not logged in",
      })
      assert.deepStrictEqual(yield* sessionCount, { rows: 0, starts: 0 })
    }),
    { unusable: ["pi", "claude", "cursor"] },
  )

  test(
    "P10/P12: setup failures are isolated; counters follow the runs",
    Effect.gen(function* () {
      const plugins = yield* Plugins
      const listed = yield* plugins.list
      const byId = (id: string) => listed.filter((q) => q.id === id)
      assert.deepInclude(listed[0], { id: "coordinator", status: "active" })
      assert.deepInclude(listed[1], { id: "harness-choice", status: "active" })
      assert.deepInclude(byId("runtime-choice")[0], { status: "active" })
      assert.deepInclude(byId("broken")[0], { id: "broken", status: "failed" })
      assert.include(byId("broken")[0]!.error, "setup boom")
      assert.deepInclude(byId("ok")[0], { id: "ok", status: "active", calls: 0 })
      assert.deepInclude(byId("ok")[1], { id: "ok", status: "failed", error: "Duplicate plugin ID: ok" })
      yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository, { harness: "pi" }))
      assert.deepInclude(
        (yield* plugins.list).find((q) => q.id === "ok")!,
        { calls: 1, changed: 1, crashed: 0 },
      )
    }),
    {
      plugins: [
        Plugin.define({
          id: "broken",
          effect: (ctx) =>
            ctx.agent
              .hook("start.before", () => Effect.sync(() => assert.fail("hook of a failed setup ran")))
              .pipe(Effect.andThen(Effect.die("setup boom"))),
        }),
        write("ok", (e) => (e.model = "m")),
        write("ok", () => {}),
      ],
    },
  )

  const stale = (id: string, name: string) =>
    Plugin.define({
      id,
      effect: (ctx) =>
        ctx.agent.hook(name as never, () => Effect.sync(() => assert.fail(`${name} ran as a startup hook`))),
    })

  it("old hook names do not type-check", () => {
    Plugin.define({
      id: "old",
      effect: (ctx) =>
        // @ts-expect-error ctx.hook is gone; register with ctx.agent.hook
        ctx.hook("session.spawn", () => Effect.void),
    })
  })

  test(
    "old and unknown hook names fail the plugin's setup instead of running at startup",
    Effect.gen(function* () {
      const s = yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository, { harness: "pi" }))
      assert.deepStrictEqual(
        s.trace.map((t) => [t.plugin, t.outcome]),
        [
          ["harness-choice", "ok"],
          ["runtime-choice", "ok"],
          ["current", "ok"],
        ],
      )
      assert.strictEqual(s.model, "m")
      const listed = yield* (yield* Plugins).list
      assert.deepStrictEqual(
        listed.map((p) => [p.id, p.status]),
        [
          ["coordinator", "active"],
          ["harness-choice", "active"],
          ["runtime-choice", "active"],
          ["session", "failed"],
          ["worker", "failed"],
          ["typo", "failed"],
          ["proto", "failed"],
          ["current", "active"],
        ],
      )
      const supported = "agent.start.before, agent.fail"
      assert.include(listed[3]!.error, `unsupported hook "agent.session.spawn"; supported: ${supported}`)
      assert.include(listed[4]!.error, `unsupported hook "agent.worker.spawn"`)
      assert.include(listed[5]!.error, `unsupported hook "agent.session.start"`)
      assert.include(listed[6]!.error, `unsupported hook "agent.toString"`)
    }),
    {
      plugins: [
        stale("session", "session.spawn"),
        stale("worker", "worker.spawn"),
        stale("typo", "session.start"),
        stale("proto", "toString"),
        write("current", (e) => (e.model = "m")),
      ],
    },
  )

  it.effect("P10: a setup that never returns times out without blocking the others", () =>
    Effect.gen(function* () {
      const building = yield* Effect.forkChild(
        Plugins.make([
          harnessChoice,
          {
            source: "hang",
            revision: "-",
            options: {},
            plugin: Plugin.define({ id: "hang", effect: () => Effect.never }),
          },
          { source: "ok", revision: "-", options: {}, plugin: write("ok", () => {}) },
        ]),
      )
      yield* TestClock.adjust("5 seconds")
      const plugins = yield* Fiber.join(building)
      assert.deepStrictEqual(
        (yield* plugins.list).map((p) => [p.id, p.status, p.error]),
        [
          ["harness-choice", "active", undefined],
          ["hang", "failed", "setup timed out"],
          ["ok", "active", undefined],
        ],
      )
    }).pipe(Effect.scoped, Effect.provide(Subscriptions.layer), Effect.provide(Runtimes.layer)),
  )
})

// ---- loading from VIBEST_HOME ----

/** VIBEST_HOME inside the package, so plugin files resolve `effect` and `@vibest/plugin` the way the repo does. */
const home = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const base = path.join(import.meta.dirname, ".tmp")
  yield* fs.makeDirectory(base, { recursive: true })
  const dir = yield* fs.makeTempDirectoryScoped({ directory: base })
  yield* fs.makeDirectory(path.join(dir, "plugins"))
  return dir
})

const source = (id: string, model: string) => `import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"
export default Plugin.define({ id: ${JSON.stringify(id)}, effect: (ctx) => ctx.agent.hook("start.before", (e) => Effect.sync(() => { e.model = ${JSON.stringify(model)} })) })
`

const loaded = (dir: string) =>
  Plugins.layer.pipe(
    Layer.provide(Layer.succeed(PluginLoader, { ...Platform.plugins, prepare: Effect.void })),
    Layer.provide(Layer.succeed(Builtins, [harnessChoice])),
    Layer.provide(Subscriptions.layer),
    Layer.provide(Layer.effect(Layout, Layout.make(dir))),
    Layer.provide(Runtimes.layer),
    Layer.build,
    Effect.map(Context.get(Plugins)),
  )

const event = {
  project: "/r",
  agentType: "general",
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
  harnesses: [
    { harness: "pi", available: true },
    { harness: "claude", available: true },
    { harness: "cursor", available: true },
  ],
}

describe("plugins: loading", () => {
  it("P1: listing order does not matter; node_modules, dot entries and .d.ts are not plugins", () => {
    assert.deepStrictEqual(pluginEntries(["b.ts", "node_modules", ".hidden.ts", "a.d.ts", "a.ts", "c"]), [
      "a.ts",
      "b.ts",
      "c",
    ])
  })

  it.live("P1: plugins/ first in path order, then vibest.json in its order; -x removes; bad entries fail visibly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* home
      const plugins = path.join(dir, "plugins")
      yield* fs.writeFileString(path.join(plugins, "b.ts"), source("b", "from-b"))
      yield* fs.writeFileString(path.join(plugins, "a.ts"), source("a", "from-a"))
      yield* fs.writeFileString(path.join(plugins, "a.d.ts"), "export {}")
      yield* fs.writeFileString(path.join(plugins, "notes.md"), "not a plugin")
      yield* fs.makeDirectory(path.join(plugins, "empty"))
      yield* fs.makeDirectory(path.join(plugins, "node_modules"))
      yield* fs.writeFileString(path.join(plugins, "broken.ts"), "export default 42\n")
      for (const name of ["x", "y"]) {
        yield* fs.makeDirectory(path.join(dir, name))
        yield* fs.writeFileString(path.join(dir, name, "index.ts"), source(name, `from-${name}`))
      }
      // A configured local plugin may be one source file too.
      yield* fs.writeFileString(path.join(dir, "a-file.ts"), source("f", "from-f"))
      const config = (entries: ReadonlyArray<unknown>) =>
        fs.writeFileString(
          path.join(dir, "vibest.json"),
          `// comments are fine\n{ "plugins": ${JSON.stringify(entries)}, }\n`,
        )

      yield* config(["./x", "./y", "-b", "vibest-plugin-npm@1.0.0", "./a-file.ts"])
      const first = yield* loaded(dir)
      assert.deepStrictEqual(
        (yield* first.list).map((p) => [p.id, p.status]),
        [
          ["harness-choice", "active"],
          ["a", "active"],
          [path.join(plugins, "broken.ts"), "failed"],
          ["x", "active"],
          ["y", "active"],
          ["vibest-plugin-npm@1.0.0", "failed"],
          ["f", "active"],
        ],
      )
      const listed = yield* first.list
      assert.include(listed.find((p) => p.id.endsWith("broken.ts"))!.error, "Plugin.define")
      assert.include(listed.find((p) => p.id.startsWith("vibest-plugin-npm"))!.error, "not supported yet")
      assert.match(listed.find((p) => p.id === "a")!.revision, /^[0-9a-f]{12}$/)
      assert.strictEqual((yield* first.start(event)).model, "from-f")

      yield* config(["-*", "./y", "./x"])
      const second = yield* loaded(dir)
      assert.deepStrictEqual(
        (yield* second.list).map((p) => p.id),
        ["harness-choice", "y", "x"],
      )
      assert.strictEqual((yield* second.start(event)).model, "from-x")
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
