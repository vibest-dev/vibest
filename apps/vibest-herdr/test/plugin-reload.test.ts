import module from "node:module"

// Plugins phase 2 (plugins.md §6 P16–P19): reloading keeps the unchanged prefix, falls back to the last working
// revision, coalesces bursts of saves, and never makes a spawn wait more than ACTIVATION_WAIT.
import { assert, describe, it } from "@effect/vitest"
import { Layout } from "@vibest/core/paths"
import { Builtins, type Candidate, makeHost, PluginLoader, Plugins } from "@vibest/core/plugins"
import { Runtimes } from "@vibest/core/runtimes"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { Plugin, type AgentStartBefore } from "@vibest/plugin"
import { harnessChoice } from "@vibest/plugin-harness-choice"
import { Context, type Crypto, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Schedule, Scope } from "effect"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

// ---- activation (virtual time) ----

/** Setups and finalizers, in the order they ran. */
const events: Array<string> = []
/** A plugin whose setup and teardown are logged as `setup <tag>` / `close <tag>`, and which writes `model = tag`. */
const logged = (id: string, tag: string, setup: Effect.Effect<void> = Effect.void) =>
  Plugin.define({
    id,
    effect: (ctx) =>
      Effect.gen(function* () {
        events.push(`setup ${tag}`)
        yield* Effect.addFinalizer(() => Effect.sync(() => events.push(`close ${tag}`)))
        yield* ctx.agent.hook("start.before", (e) => Effect.sync(() => void (e.model = tag)))
        yield* setup
      }),
  })
const candidate = (
  source: string,
  revision: string,
  plugin: Candidate["plugin"],
  options: Record<string, unknown> = {},
): Candidate => ({ source, revision, options, plugin })
const a1 = candidate("a", "1", logged("a", "a1"))
const a2 = candidate("a", "2", logged("a", "a2"))
const b1 = candidate("b", "1", logged("b", "b1"))
const b2 = candidate("b", "2", logged("b", "b2"))
const c1 = candidate("c", "1", logged("c", "c1"))

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
const ids = (host: Effect.Success<ReturnType<typeof makeHost>>) =>
  host.service.list.pipe(Effect.map((l) => l.map((p) => [p.id, p.status, p.revision])))
const takeEvents = Effect.sync(() => events.splice(0))

const host = <A, E>(f: (host: Effect.Success<ReturnType<typeof makeHost>>) => Effect.Effect<A, E>) =>
  makeHost().pipe(Effect.flatMap(f), Effect.scoped, Effect.provide(Subscriptions.layer), Effect.provide(Runtimes.layer))

describe("plugins: activation", () => {
  it.effect(
    "P16: changing the second of three keeps the first; the rest is torn down last-first and rebuilt in order",
    () =>
      host((h) =>
        Effect.gen(function* () {
          yield* takeEvents
          yield* h.activate([a1, b1, c1])
          assert.deepStrictEqual(yield* takeEvents, ["setup a1", "setup b1", "setup c1"])
          yield* h.activate([a1, b2, c1])
          assert.deepStrictEqual(yield* takeEvents, ["close c1", "close b1", "setup b2", "setup c1"])
          assert.deepStrictEqual(yield* ids(h), [
            ["a", "active", "1"],
            ["b", "active", "2"],
            ["c", "active", "1"],
          ])
          const s = yield* h.service.start(event)
          assert.deepStrictEqual(
            s.trace.map((t) => [t.plugin, t.changes.at(-1)?.to]),
            [
              ["a", "a1"],
              ["b", "b2"],
              ["c", "c1"],
            ],
          )
          // Nothing changed: nothing runs.
          yield* h.activate([a1, b2, c1])
          assert.deepStrictEqual(yield* takeEvents, [])
        }),
      ),
  )

  it.effect("removal, reorder and options changes rebuild from the first difference", () =>
    host((h) =>
      Effect.gen(function* () {
        yield* h.activate([a1, b1, c1])
        yield* takeEvents
        yield* h.activate([a1, c1])
        assert.deepStrictEqual(yield* takeEvents, ["close c1", "close b1", "setup c1"])
        yield* h.activate([c1, a1])
        assert.deepStrictEqual(yield* takeEvents, ["close c1", "close a1", "setup c1", "setup a1"])
        yield* h.activate([c1, { ...a1, options: { level: 2 } }])
        assert.deepStrictEqual(yield* takeEvents, ["close a1", "setup a1"])
        yield* h.activate([])
        assert.deepStrictEqual(yield* takeEvents, ["close a1", "close c1"])
        assert.deepStrictEqual(yield* ids(h), [])
      }),
    ),
  )

  it.effect("a duplicate id fails until the first one goes; then it is set up", () =>
    host((h) =>
      Effect.gen(function* () {
        const other = candidate("other", "1", logged("a", "other"))
        yield* h.activate([a1, other])
        assert.deepStrictEqual(
          (yield* h.service.list).map((p) => [p.source, p.status, p.error]),
          [
            ["a", "active", undefined],
            ["other", "failed", "Duplicate plugin ID: a"],
          ],
        )
        yield* takeEvents
        yield* h.activate([other])
        assert.deepStrictEqual(yield* takeEvents, ["close a1", "setup other"])
        assert.deepStrictEqual(yield* ids(h), [["a", "active", "1"]])
      }),
    ),
  )

  it.effect(
    "P17: a failing setup keeps the last working revision, is not retried while unchanged, and a fix recovers",
    () =>
      host((h) =>
        Effect.gen(function* () {
          const broken = candidate("b", "2", logged("b", "b2", Effect.die("setup boom")))
          yield* h.activate([a1, b1, c1])
          yield* takeEvents
          yield* h.activate([a1, broken, c1])
          assert.deepStrictEqual(yield* takeEvents, [
            "close c1",
            "close b1",
            "setup b2",
            "close b2",
            "setup b1",
            "setup c1",
          ])
          const [, b] = yield* h.service.list
          assert.deepInclude(b, { id: "b", status: "active", revision: "1" })
          assert.include(b!.error, "revision 2 failed, still running 1: setup boom")
          assert.strictEqual((yield* h.service.start(event)).trace[1]!.changes[0]!.to, "b1")

          // A change before it rebuilds b: the old revision again, not the failed one.
          yield* h.activate([a2, broken, c1])
          assert.deepStrictEqual(yield* takeEvents, [
            "close c1",
            "close b1",
            "close a1",
            "setup a2",
            "setup b1",
            "setup c1",
          ])

          yield* h.activate([a2, candidate("b", "3", logged("b", "b3")), c1])
          assert.deepStrictEqual(yield* takeEvents, ["close c1", "close b1", "setup b3", "setup c1"])
          const [, fixed] = yield* h.service.list
          assert.deepInclude(fixed, { status: "active", revision: "3" })
          assert.isUndefined(fixed!.error)
        }),
      ),
  )

  it.effect("P17: a revision that fails to import keeps the last working one; with none it is failed", () =>
    host((h) =>
      Effect.gen(function* () {
        yield* h.activate([a1, candidate("new", "9", { error: "import failed: nope" })])
        yield* h.activate([a1, b1])
        yield* takeEvents
        yield* h.activate([a1, candidate("b", "2", { error: "import failed: SyntaxError" })])
        assert.deepStrictEqual(yield* takeEvents, ["close b1", "setup b1"])
        const [, b] = yield* h.service.list
        assert.deepInclude(b, { id: "b", status: "active", revision: "1" })
        assert.include(b!.error, "import failed: SyntaxError")
      }),
    ),
  )

  it.effect(
    "L5: the last working revision is restored only under the same rules, and why it was not stays visible",
    () =>
      host((h) =>
        Effect.gen(function* () {
          // b's next revision fails setup while its old id now belongs to another plugin earlier in the order.
          const renamed = candidate("b", "2", logged("b-next", "b2", Effect.die("setup boom")))
          const taker = candidate("t", "1", logged("b", "taker"))
          yield* h.activate([b1])
          yield* takeEvents
          yield* h.activate([taker, renamed])
          assert.deepStrictEqual(yield* takeEvents, ["close b1", "setup taker", "setup b2", "close b2"])
          const [, b] = yield* h.service.list
          assert.deepInclude(b, { status: "failed" })
          assert.include(b!.error, "setup boom")
          assert.include(b!.error, "revision 1 not restored: Duplicate plugin ID: b")
          // Rebuilt unchanged after an earlier change: still not retried, still explained.
          yield* h.activate([{ ...taker, revision: "2" }, renamed])
          assert.deepStrictEqual(yield* takeEvents, ["close taker", "setup taker"])
          assert.include((yield* h.service.list)[1]!.error, "not restored: Duplicate plugin ID: b")
        }),
      ),
  )

  it.effect("L5: a restore that fails too keeps both errors", () =>
    host((h) =>
      Effect.gen(function* () {
        let setups = 0
        const once = Plugin.define({
          id: "o",
          effect: () => (++setups === 1 ? Effect.void : Effect.die("restore boom")),
        })
        yield* h.activate([candidate("o", "1", once)])
        yield* h.activate([candidate("o", "2", Plugin.define({ id: "o", effect: () => Effect.die("new boom") }))])
        const [o] = yield* h.service.list
        assert.deepInclude(o, { status: "failed" })
        assert.include(o!.error, "new boom")
        assert.include(o!.error, "revision 1 not restored: restore boom")
      }),
    ),
  )

  it.effect("P19: a spawn waits for a pending activation at most 10s, then goes on with the active plugins", () =>
    host((h) =>
      Effect.gen(function* () {
        yield* h.activate([a1])
        h.ready.closeUnsafe()
        // A setup stuck in an uninterruptible region, like a hung activation.
        const stuck = candidate("s", "1", logged("s", "s1", Effect.uninterruptible(Effect.sleep("1 hour"))))
        const activating = yield* Effect.forkChild(h.activate([a1, stuck]).pipe(Effect.ensuring(h.ready.open)))
        const spawning = yield* Effect.forkChild(h.service.start(event))
        yield* TestClock.adjust("9 seconds")
        assert.isUndefined(spawning.pollUnsafe(), "still waiting before 10s")
        yield* TestClock.adjust("1 second")
        const s = yield* Fiber.join(spawning)
        assert.deepStrictEqual(
          s.trace.map((t) => [t.plugin, t.outcome, t.error]),
          [
            ["vibest", "timeout", "plugins still activating"],
            ["a", "ok", undefined],
          ],
        )
        assert.strictEqual(s.model, "a1")
        yield* TestClock.adjust("1 hour")
        yield* Fiber.join(activating)
        // Settled: no wait and no note.
        assert.deepStrictEqual(
          (yield* h.service.start(event)).trace.map((t) => t.plugin),
          ["a"],
        )
      }),
    ),
  )

  it.effect("a teardown that never finishes does not block the reload", () =>
    host((h) =>
      Effect.gen(function* () {
        // Finalizers are uninterruptible: this one holds its scope for an hour.
        const sticky = Plugin.define({ id: "sticky", effect: () => Effect.addFinalizer(() => Effect.sleep("1 hour")) })
        yield* h.activate([candidate("sticky", "1", sticky)])
        const reloading = yield* Effect.forkChild(h.activate([a1]))
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow
        yield* TestClock.adjust("5 seconds")
        yield* Fiber.join(reloading)
        assert.deepStrictEqual(yield* ids(h), [["a", "active", "1"]])
        yield* TestClock.adjust("1 hour")
      }),
    ),
  )

  it.effect("a hook in flight finishes before its plugin is torn down", () =>
    host((h) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const slow = Plugin.define({
          id: "slow",
          effect: (ctx) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sync(() => events.push("close slow")))
              yield* ctx.agent.hook("start.before", (e: AgentStartBefore) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.andThen(Effect.sync(() => void (e.model = "slow"))),
                ),
              )
            }),
        })
        yield* h.activate([candidate("slow", "1", slow)])
        yield* takeEvents
        const spawning = yield* Effect.forkChild(h.service.start(event))
        yield* Deferred.await(entered)
        const reloading = yield* Effect.forkChild(h.activate([]))
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow
        assert.deepStrictEqual(events, [], "not torn down while its hook runs")
        yield* Deferred.succeed(gate, undefined)
        assert.strictEqual((yield* Fiber.join(spawning)).model, "slow")
        yield* Fiber.join(reloading)
        assert.deepStrictEqual(yield* takeEvents, ["close slow"])
      }),
    ),
  )
})

// ---- the supervisor on a real VIBEST_HOME (live clock, real files and watchers) ----

/** Counters plugin files bump through globalThis: imports (module evaluation) and setups. */
const counters = ((globalThis as { __vibestReload?: Record<string, number> }).__vibestReload ??= {})
const count = (key: string) => counters[key] ?? 0

/** A plugin file: its import and its setup are counted under `key`; its hook writes `model` (an expression). */
const pluginFile = (id: string, key: string, model: string, imports = "") => `${imports}
import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"
const c = (globalThis.__vibestReload ??= {})
c["import:${key}"] = (c["import:${key}"] ?? 0) + 1
export default Plugin.define({
  id: ${JSON.stringify(id)},
  effect: (ctx) => Effect.sync(() => { c["setup:${key}"] = (c["setup:${key}"] ?? 0) + 1 }).pipe(Effect.andThen(ctx.agent.hook("start.before", (e) => Effect.sync(() => { e.model = ${model} })))),
})
`

/** Watchers still open, to see they follow the plugin set and end with vibestd. */
const watchers = { open: 0 }
/** Fault injection for the rescan: drop every watch event for `dropMs` after any watch closes (`dropped` counts them). */
const faults = { dropMs: 0, droppedUntil: 0, dropped: 0 }
/** When `hold` is set, watcher callbacks queue here instead of reaching the supervisor. */
const watchGate: { hold: boolean; pending: Array<{ name: string; deliver: () => void }> } = { hold: false, pending: [] }
/** Reads of vibest.json, one per supervisor read: to see the rescan ends instead of polling. */
const reads = { count: 0 }
// vitest's import() goes through its own module cache, so here plugins load with Bun's native require after the same
// registry eviction; the real loader (eviction, then dynamic import) runs on the compiled binary in plugin-binary.test.ts.
const nativeRequire = module.createRequire(import.meta.url)
const loader: PluginLoader["Service"] = {
  ...Platform.plugins,
  prepare: Effect.void,
  parseJsonc: (text) => {
    reads.count++
    return Platform.plugins.parseJsonc(text)
  },
  load: async (entry, files) => {
    for (const file of files) delete nativeRequire.cache[file]
    return nativeRequire(entry)
  },
  watch: (directory, changed) => {
    const stop = Platform.plugins.watch(directory, (name) => {
      if (Date.now() < faults.droppedUntil) faults.dropped++
      else if (watchGate.hold) watchGate.pending.push({ name, deliver: () => changed(name) })
      else changed(name)
    })
    watchers.open++
    return () => {
      watchers.open--
      faults.droppedUntil = Date.now() + faults.dropMs
      stop()
    }
  },
}

/** VIBEST_HOME inside the package, so plugin files resolve `effect` and `@vibest/plugin` the way the repo does. */
const home = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const base = path.join(import.meta.dirname, ".tmp")
  yield* fs.makeDirectory(base, { recursive: true })
  const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ directory: base }))
  yield* fs.makeDirectory(path.join(dir, "plugins"))
  return dir
})

/** The supervised layer on `dir`, built in its own scope so a test can close it. The default harness choice is loaded
 *  first, as the product does; these tests watch user plugins, so `list` hides it. */
const supervise = (dir: string) =>
  Plugins.layer.pipe(
    Layer.provide(Layer.succeed(PluginLoader, loader)),
    Layer.provide(Layer.succeed(Builtins, [harnessChoice])),
    Layer.provide(Subscriptions.layer),
    Layer.provide(Layer.effect(Layout, Layout.make(dir))),
    Layer.provide(Runtimes.layer),
    Layer.build,
    Effect.map(Context.get(Plugins)),
    Effect.map((plugins) => ({
      ...plugins,
      list: plugins.list.pipe(Effect.map((all) => all.filter((p) => p.source !== "builtin:harness-choice"))),
    })),
  )

/** Wait (real time, at most 5s) until `f` satisfies `done`. */
const eventually = <A, E, R>(f: Effect.Effect<A, E, R>, done: (a: A) => boolean, what: string) =>
  f.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("20 millis"), times: 250 }),
    Effect.filterOrElse(done, (a) => Effect.die(`gave up waiting for ${what}: ${JSON.stringify(a)}`)),
  )
/** Same bound as `eventually`, but real time: `it.effect` freezes the test clock, so a schedule would not wait. */
const waitLive = (ready: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 250 && !ready(); i++) yield* TestClock.withLive(Effect.sleep("20 millis"))
    if (!ready())
      yield* Effect.die(`gave up waiting for ${what}: ${JSON.stringify(watchGate.pending.map((e) => e.name))}`)
  })
/** Past the 100ms debounce, so a burst has already become one reload. */
const quiet = Effect.sleep("150 millis")
/** The one post-watch rescan (RECHECK is 1s), or 1.5s when that read never comes. */
const pastRescan = Effect.gen(function* () {
  const start = reads.count
  for (let i = 0; i < 75 && reads.count === start; i++) yield* Effect.sleep("20 millis")
})

const live = <E>(
  name: string,
  program: Effect.Effect<void, E, FileSystem.FileSystem | Path.Path | Crypto.Crypto | Scope.Scope>,
) => it.live(name, () => program.pipe(Effect.scoped, Effect.provide(Platform.services)), { timeout: 20_000 })

/** Run `effect` while moving virtual time in 500ms steps, letting real I/O run in between. */
const advancing = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect)
    for (let i = 0; i < 400 && fiber.pollUnsafe() === undefined; i++) {
      yield* TestClock.withLive(Effect.sleep("5 millis"))
      yield* TestClock.adjust("500 millis")
    }
    return yield* Fiber.join(fiber)
  })

describe("plugins: supervisor", () => {
  live(
    "a dependency edit (atomic save) reloads the changed transitive import, without touching the entry",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* home
      yield* fs.makeDirectory(path.join(dir, "lib"))
      yield* fs.writeFileString(path.join(dir, "lib", "value.ts"), `export const value = "v1"\n`)
      yield* fs.writeFileString(
        path.join(dir, "plugins", "dep.ts"),
        pluginFile("dep", "dep", "value", `import { value } from "../lib/value.ts"`),
      )
      const plugins = yield* supervise(dir)
      assert.strictEqual((yield* plugins.start(event)).model, "v1")
      const [before] = yield* plugins.list
      // Editors save by writing a temp file and renaming it over the original.
      yield* fs.writeFileString(path.join(dir, "lib", "value.ts.tmp"), `export const value = "v2"\n`)
      yield* fs.rename(path.join(dir, "lib", "value.ts.tmp"), path.join(dir, "lib", "value.ts"))
      yield* eventually(plugins.start(event), (s) => s.model === "v2", "the new dependency value")
      const [after] = yield* plugins.list
      assert.notStrictEqual(after!.revision, before!.revision)
      assert.strictEqual(count("import:dep"), 2)
    }),
  )

  live(
    "P17/P18: a burst of saves is one reload; a broken save keeps the old plugin, unrelated saves do not re-import it, a fix recovers",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* home
      const file = path.join(dir, "plugins", "p.ts")
      const other = path.join(dir, "plugins", "q.ts")
      yield* fs.writeFileString(file, pluginFile("p", "p", `"p0"`))
      yield* fs.writeFileString(other, pluginFile("q", "q", "e.model"))
      const plugins = yield* supervise(dir)
      assert.strictEqual((yield* plugins.start(event)).model, "p0")
      const [imports, setups] = [count("import:p"), count("setup:p")]

      // P18: ten saves in one quick burst (no artificial gaps: a loaded machine must not split them across debounce windows).
      for (let i = 1; i <= 10; i++) {
        yield* fs.writeFileString(file, pluginFile("p", "p", `"p${i}"`))
      }
      yield* eventually(plugins.start(event), (s) => s.model === "p10", "the last save")
      yield* quiet
      assert.deepStrictEqual([count("import:p") - imports, count("setup:p") - setups], [1, 1])

      // P17: broken at import time (after a side effect).
      yield* fs.writeFileString(file, `globalThis.__vibestReload["import:p"]++\nthrow new Error("broken on purpose")\n`)
      const listed = yield* eventually(plugins.list, (l) => l[0]?.error !== undefined, "the import error")
      assert.deepInclude(listed[0], { id: "p", status: "active" })
      assert.include(listed[0]!.error, "broken on purpose")
      assert.strictEqual((yield* plugins.start(event)).model, "p10", "the last working revision still runs")
      const brokenImports = count("import:p")

      // Unrelated saves: q (after p) and a new a.ts (before p, so p is rebuilt) never import p again.
      yield* fs.writeFileString(other, pluginFile("q", "q", `"q1"`))
      yield* eventually(plugins.start(event), (s) => s.model === "q1", "q's new revision")
      yield* fs.writeFileString(path.join(dir, "plugins", "a.ts"), pluginFile("a", "a", "e.model"))
      yield* eventually(plugins.list, (l) => l.length === 3, "a new first plugin")
      yield* quiet
      assert.strictEqual(count("import:p"), brokenImports, "a broken revision is not imported again while unchanged")

      yield* fs.writeFileString(file, pluginFile("p", "p", `"fixed"`))
      const fixed = yield* eventually(
        plugins.list,
        (l) => l.some((p) => p.id === "p" && p.error === undefined),
        "the fix",
      )
      assert.deepInclude(
        fixed.find((p) => p.id === "p"),
        { status: "active" },
      )
    }),
  )

  live(
    "file plugins renamed, removed and added again; a directory plugin removed and re-created",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* home
      const plugins = path.join(dir, "plugins")
      yield* fs.writeFileString(path.join(plugins, "a.ts"), pluginFile("a", "ra", `"a"`))
      yield* fs.makeDirectory(path.join(plugins, "d"))
      yield* fs.writeFileString(path.join(plugins, "d", "index.ts"), pluginFile("d", "rd", `"d"`))
      const service = yield* supervise(dir)
      const sources = service.list.pipe(Effect.map((l) => l.map((p) => path.relative(plugins, p.source))))
      assert.deepStrictEqual(yield* sources, ["a.ts", "d/index.ts"])
      yield* fs.rename(path.join(plugins, "a.ts"), path.join(plugins, "z.ts"))
      yield* eventually(sources, (s) => s.join() === "d/index.ts,z.ts", "the rename")
      yield* fs.remove(path.join(plugins, "z.ts"))
      yield* fs.remove(path.join(plugins, "d"), { recursive: true })
      yield* eventually(sources, (s) => s.length === 0, "the removals")
      yield* fs.makeDirectory(path.join(plugins, "d"))
      yield* fs.writeFileString(path.join(plugins, "d", "server.ts"), pluginFile("d", "rd", `"d2"`))
      yield* fs.writeFileString(path.join(plugins, "a.ts"), pluginFile("a", "ra", `"a2"`))
      yield* eventually(sources, (s) => s.join() === "a.ts,d/server.ts", "the re-adds")
      assert.strictEqual((yield* service.start(event)).model, "d2")
    }),
  )

  live(
    "a malformed vibest.json keeps the last valid plugin list; watchers follow the list and end with vibestd",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* home
      yield* fs.makeDirectory(path.join(dir, "x"))
      yield* fs.writeFileString(path.join(dir, "x", "index.ts"), pluginFile("x", "x", `"x"`))
      const config = path.join(dir, "vibest.json")
      yield* fs.writeFileString(config, `{ "plugins": ["./x"] }`)
      const scope = yield* Scope.make()
      const before = watchers.open
      const plugins = yield* supervise(dir).pipe(Scope.provide(scope))
      assert.strictEqual((yield* plugins.start(event)).model, "x")
      // home (vibest.json, plugins), plugins/ and x/.
      assert.strictEqual(watchers.open - before, 3)

      yield* fs.writeFileString(config, `{ "plugins": ["./x", `)
      yield* quiet
      assert.strictEqual((yield* plugins.start(event)).model, "x", "a half-saved vibest.json changes nothing")

      // Unrelated files in VIBEST_HOME (the database, results) do not reload anything.
      const setups = count("setup:x")
      yield* fs.writeFileString(path.join(dir, "vibest.db"), "churn")
      yield* quiet
      assert.strictEqual(count("setup:x"), setups)

      yield* fs.writeFileString(config, `{ "plugins": [] }`)
      yield* eventually(plugins.list, (l) => l.length === 0, "x removed")
      assert.strictEqual(watchers.open - before, 2, "x/ is no longer watched")
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual(watchers.open, before, "vibestd's end closes every watcher")
    }),
  )

  live(
    "a spawn right after start waits for the first activation instead of running without plugins",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* home
      yield* fs.writeFileString(path.join(dir, "plugins", "early.ts"), pluginFile("early", "early", `"early"`))
      const s = yield* (yield* supervise(dir)).start(event)
      assert.deepStrictEqual(
        s.trace.map((t) => [t.plugin, t.outcome]),
        [
          ["harness-choice", "ok"],
          ["early", "ok"],
        ],
      )
      assert.strictEqual(s.model, "early")
    }),
  )

  it.effect(
    "P19 on vibestd: a stuck first activation blocks neither the layer (vibestd listens) nor a spawn past 10s",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* home
        yield* fs.writeFileString(path.join(dir, "plugins", "a.ts"), pluginFile("a", "stuck-a", `"a"`))
        // Its setup sits in an uninterruptible region for a (virtual) minute.
        yield* fs.writeFileString(
          path.join(dir, "plugins", "b.ts"),
          `import { Plugin } from "@vibest/plugin"\nimport { Effect } from "effect"\nexport default Plugin.define({ id: "b", effect: () => Effect.uninterruptible(Effect.sleep("1 minute")) })\n`,
        )
        // Built without moving virtual time: the first activation runs in the background.
        const plugins = yield* supervise(dir)
        // a's import is real I/O: until it is set up, moving virtual time would spend the 10s before a is active.
        yield* waitLive(() => count("setup:stuck-a") > 0, "a's setup")
        const s = yield* advancing(plugins.start(event))
        assert.deepStrictEqual(
          s.trace.map((t) => [t.plugin, t.outcome, t.error]),
          [
            ["vibest", "timeout", "plugins still activating"],
            ["harness-choice", "ok", undefined],
            ["a", "ok", undefined],
          ],
        )
        assert.strictEqual(s.model, "a")
        assert.deepStrictEqual(
          (yield* advancing(plugins.list)).map((p) => [p.id, p.status, p.error]),
          [
            ["a", "active", undefined],
            ["b", "failed", "setup timed out"],
          ],
        )
        // Past b's uninterruptible minute, so its scope can close at teardown.
        yield* TestClock.adjust("1 minute")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  live(
    "H2: under a symlinked VIBEST_HOME, a plugin added after start loads (and an edit of it reloads)",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const real = yield* home
      const link = `${real}-link`
      yield* fs.symlink(real, link)
      yield* Effect.addFinalizer(() => fs.remove(link).pipe(Effect.ignore))
      yield* fs.writeFileString(path.join(link, "plugins", "a.ts"), pluginFile("a", "h2-a", "e.model"))
      const plugins = yield* supervise(link)
      assert.deepStrictEqual(
        (yield* plugins.list).map((p) => p.status),
        ["active"],
      )
      yield* fs.writeFileString(path.join(link, "plugins", "new.ts"), pluginFile("new", "h2-new", `"n1"`))
      yield* eventually(plugins.start(event), (s) => s.model === "n1", "the plugin added after start")
      yield* fs.writeFileString(path.join(link, "plugins", "new.ts"), pluginFile("new", "h2-new", `"n2"`))
      yield* eventually(plugins.start(event), (s) => s.model === "n2", "its edit")
    }),
  )

  live(
    "M3: a symlinked entry follows its real file: real dependency edits, retargeting, a dangling link and its repair",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* home
      const entryFile = (dep: string) => pluginFile("s", "m3", "value", `import { value } from "./${dep}"`)
      for (const [sub, value] of [
        ["one", "one-1"],
        ["two", "two-1"],
      ] as const) {
        yield* fs.makeDirectory(path.join(dir, sub))
        yield* fs.writeFileString(path.join(dir, sub, "dep.ts"), `export const value = ${JSON.stringify(value)}\n`)
        yield* fs.writeFileString(path.join(dir, sub, "entry.ts"), entryFile("dep.ts"))
      }
      const link = path.join(dir, "plugins", "s.ts")
      yield* fs.symlink(path.join(dir, "one", "entry.ts"), link)
      const plugins = yield* supervise(dir)
      assert.strictEqual((yield* plugins.start(event)).model, "one-1", "./dep.ts resolves next to the real entry")

      yield* fs.writeFileString(path.join(dir, "one", "dep.ts"), `export const value = "one-2"\n`)
      yield* eventually(plugins.start(event), (s) => s.model === "one-2", "an edit of the real dependency")

      yield* fs.remove(link)
      yield* fs.symlink(path.join(dir, "two", "entry.ts"), link)
      yield* eventually(plugins.start(event), (s) => s.model === "two-1", "the retargeted link")

      yield* fs.remove(path.join(dir, "two", "entry.ts"))
      const dangling = yield* eventually(plugins.list, (l) => l[0]?.error !== undefined, "the dangling link")
      assert.deepInclude(dangling[0], { status: "active" }, "the last working revision keeps running")
      yield* fs.writeFileString(path.join(dir, "two", "entry.ts"), entryFile("dep.ts"))
      yield* fs.writeFileString(path.join(dir, "two", "dep.ts"), `export const value = "two-2"\n`)
      yield* eventually(plugins.start(event), (s) => s.model === "two-2", "the repaired target")
      assert.isUndefined((yield* plugins.list)[0]!.error)
    }),
  )

  live(
    "a configured plugin directory that does not exist yet is picked up when it is created",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* home
      yield* fs.writeFileString(path.join(dir, "vibest.json"), `{ "plugins": ["./later/x"] }`)
      const plugins = yield* supervise(dir)
      assert.deepStrictEqual(yield* plugins.list, [])
      yield* pastRescan // past the rescan after start, so only a watch can see what comes next
      // Two levels missing: watched for in VIBEST_HOME, then in later/.
      yield* fs.makeDirectory(path.join(dir, "later", "x"), { recursive: true })
      yield* fs.writeFileString(path.join(dir, "later", "x", "index.ts"), pluginFile("x", "later-x", `"x"`))
      yield* eventually(plugins.list, (l) => l[0]?.status === "active", "the new directory plugin")
      assert.strictEqual((yield* plugins.start(event)).model, "x")
    }),
  )

  live(
    "a change the watcher dropped right after a watch closed is found by the one rescan, which then stops",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* home
      const plugins = path.join(dir, "plugins")
      yield* fs.writeFileString(path.join(dir, "vibest.json"), `{}`)
      yield* fs.writeFileString(path.join(plugins, "a.ts"), pluginFile("a", "drop-a", `"a1"`))
      yield* fs.makeDirectory(path.join(plugins, "d"))
      yield* fs.writeFileString(path.join(plugins, "d", "index.ts"), pluginFile("d", "drop-d", "e.model"))
      const service = yield* supervise(dir)
      yield* eventually(service.list, (l) => l.length === 2, "both plugins")
      yield* Effect.sleep("1500 millis") // past the first rescan (a fixed wait: any read could end pastRescan early)
      faults.dropMs = 500
      faults.dropped = 0
      try {
        // Removing d closes its watch; the save of a.ts right after it is dropped, as Bun sometimes does on macOS.
        yield* fs.remove(path.join(plugins, "d"), { recursive: true })
        yield* eventually(service.list, (l) => l.length === 1, "d removed")
        yield* fs.writeFileString(path.join(plugins, "a.ts"), pluginFile("a", "drop-a", `"a2"`))
        // Under load the watcher reports the save late; wait for it rather than a fixed 100 ms.
        yield* eventually(
          Effect.sync(() => faults.dropped),
          (n) => n > 0,
          "the save's events were dropped",
        )
        assert.strictEqual((yield* service.start(event)).model, "a1", "not seen yet")
        yield* eventually(service.start(event), (s) => s.model === "a2", "the rescan to find the save")
      } finally {
        faults.dropMs = 0
      }
      // One rescan per change of the watched set, not polling: reads stop.
      const settled = reads.count
      yield* Effect.sleep("2500 millis")
      assert.strictEqual(reads.count, settled)
    }),
  )

  it.effect(
    "P19: a change during a stuck activation keeps readiness closed until that change is active too",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* home
        const entered = ((globalThis as { __vibestStuck?: { value: boolean } }).__vibestStuck = { value: false })
        watchGate.hold = true
        watchGate.pending = []
        // First in order; its setup holds an uninterruptible region for 6 (virtual) seconds.
        yield* fs.writeFileString(
          path.join(dir, "plugins", "a.ts"),
          `import { Plugin } from "@vibest/plugin"\nimport { Effect } from "effect"\nexport default Plugin.define({ id: "a", effect: () => Effect.sync(() => { globalThis.__vibestStuck.value = true }).pipe(Effect.andThen(Effect.uninterruptible(Effect.sleep("6 seconds")))) })\n`,
        )
        yield* fs.writeFileString(path.join(dir, "plugins", "z.ts"), pluginFile("z", "pending-z", `"z1"`))
        const plugins = yield* supervise(dir)
        while (!entered.value) yield* TestClock.withLive(Effect.sleep("5 millis"))
        yield* fs.writeFileString(path.join(dir, "plugins", "z.ts"), pluginFile("z", "pending-z", `"z2"`))
        // The overwrite counts only once the watcher has it. A fixed sleep advances the clock either too soon (spawn runs z1)
        // or, via advancing(), through the 10s budget while the reload's real import is still running (trace starts with vibest).
        yield* waitLive(() => watchGate.pending.some((change) => change.name === "z.ts"), "the watcher to observe z.ts")
        for (const change of watchGate.pending.splice(0)) if (change.name === "z.ts") change.deliver()
        // hold stays set: a duplicate event during the real import would close readiness, and this frozen clock would not run that debounce.
        const spawning = yield* Effect.forkChild(plugins.start(event))
        yield* TestClock.adjust("6 seconds")
        assert.isUndefined(spawning.pollUnsafe(), "readiness opened on the pre-change activation")
        yield* TestClock.adjust("200 millis")
        const s = yield* TestClock.withLive(Fiber.join(spawning).pipe(Effect.timeout("5 seconds")))
        assert.strictEqual(s.model, "z2")
        assert.deepStrictEqual(
          s.trace.map((t) => t.plugin),
          ["harness-choice", "z"],
        )
        assert.deepStrictEqual(
          (yield* plugins.list).map((p) => [p.id, p.status, p.error]),
          [
            ["a", "failed", "setup timed out"],
            ["z", "active", undefined],
          ],
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            watchGate.hold = false
            watchGate.pending = []
          }),
        ),
        Effect.scoped,
        Effect.provide(Platform.services),
      ),
    15_000,
  )
})
