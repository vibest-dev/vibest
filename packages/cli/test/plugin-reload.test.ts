import module from "node:module"

import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Harnesses } from "@vibest/core/harness"
import { Layout } from "@vibest/core/paths"
import { Builtins, type Candidate, DEBOUNCE, makeHost, PluginLoader, Plugins, RECHECK } from "@vibest/core/plugins"
import { Runtimes } from "@vibest/core/runtimes"
import { Plugin, type AgentStartBefore, type Harness, type Runtime } from "@vibest/plugin"
import {
  Clock,
  Context,
  type Crypto,
  Duration,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Path,
  Schedule,
  Scope,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { runtimesLayer, subscriptionsLayer, harnessesLayer } from "./fakes.ts"

const events: Array<string> = []
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
  makeHost().pipe(
    Effect.flatMap(f),
    Effect.scoped,
    Effect.provide(subscriptionsLayer),
    Effect.provide(harnessesLayer()),
    Effect.provide(runtimesLayer),
    Effect.provide(Bus.layer),
  )

describe("plugins: registrations", () => {
  const edits = (id: string, edit: (editor: Harness.HarnessEditor) => void) =>
    candidate(id, "1", Plugin.define({ id, effect: (ctx) => ctx.harness.transform(edit).pipe(Effect.asVoid) }))
  const registered = <A, E>(f: (h: Effect.Success<ReturnType<typeof makeHost>>) => Effect.Effect<A, E, Harnesses>) =>
    makeHost().pipe(
      Effect.flatMap(f),
      Effect.scoped,
      Effect.provide(subscriptionsLayer),
      Effect.provide(harnessesLayer()),
      Effect.provide(runtimesLayer),
      Effect.provide(Bus.layer),
    )

  it.effect("a boot of several plugins commits their transforms once", () =>
    registered((h) =>
      Effect.gen(function* () {
        let runs = 0
        yield* h.activate([
          edits("count", () => void runs++),
          edits("glm", (e) => e.update("claude", (d) => void (d.binary = "glm"))),
          edits("other", (e) => e.update("pi", (d) => void (d.binary = "pi2"))),
        ])
        assert.strictEqual(runs, 1)
        assert.strictEqual((yield* (yield* Harnesses).get("claude")).binary, "glm")
      }),
    ),
  )

  it.effect("a throwing transform fails its plugin and leaves the others' definitions in place", () =>
    registered((h) =>
      Effect.gen(function* () {
        yield* h.activate([
          edits("glm", (e) => e.update("claude", (d) => void (d.binary = "glm"))),
          edits("bad", (e) => {
            e.update("pi", (d) => void (d.binary = "broken"))
            throw new Error("boom")
          }),
        ])
        const listed = yield* h.service.list
        assert.strictEqual(listed.find((p) => p.id === "bad")?.status, "failed")
        assert.include(listed.find((p) => p.id === "bad")?.error ?? "", "boom")
        assert.strictEqual(listed.find((p) => p.id === "glm")?.status, "active")
        const harnesses = yield* Harnesses
        assert.strictEqual((yield* harnesses.get("claude")).binary, "glm")
        assert.strictEqual((yield* harnesses.get("pi")).binary, "pi")
      }),
    ),
  )

  it.effect("removing a plugin restores the definition it changed or removed", () =>
    registered((h) =>
      Effect.gen(function* () {
        const harnesses = yield* Harnesses
        const before = yield* harnesses.get("claude")
        yield* h.activate([edits("drop", (e) => e.remove("claude"))])
        assert.isUndefined(harnesses.find("claude"))
        yield* h.activate([])
        assert.strictEqual(harnesses.find("claude"), before)
      }),
    ),
  )
})

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
          yield* h.activate([a1, b2, c1])
          assert.deepStrictEqual(yield* takeEvents, [], "nothing changed: nothing runs")
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

          yield* h.activate([a2, broken, c1])
          assert.deepStrictEqual(
            yield* takeEvents,
            ["close c1", "close b1", "close a1", "setup a2", "setup b1", "setup c1"],
            "a change before b rebuilds it from the old revision, not the failed one",
          )

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
          const bNextFailingSetup = candidate("b", "2", logged("b-next", "b2", Effect.die("setup boom")))
          const taker = candidate("t", "1", logged("b", "taker"))
          yield* h.activate([b1])
          yield* takeEvents
          yield* h.activate([taker, bNextFailingSetup])
          assert.deepStrictEqual(yield* takeEvents, ["close b1", "setup taker", "setup b2", "close b2"])
          const [, b] = yield* h.service.list
          assert.deepInclude(b, { status: "failed" })
          assert.include(b!.error, "setup boom")
          assert.include(b!.error, "revision 1 not restored: Duplicate plugin ID: b")
          yield* h.activate([{ ...taker, revision: "2" }, bNextFailingSetup])
          assert.deepStrictEqual(
            yield* takeEvents,
            ["close taker", "setup taker"],
            "rebuilt unchanged after an earlier change: not retried",
          )
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
        const hungUninterruptibleSetup = candidate(
          "s",
          "1",
          logged("s", "s1", Effect.uninterruptible(Effect.sleep("1 hour"))),
        )
        const activating = yield* Effect.forkChild(
          h.activate([a1, hungUninterruptibleSetup]).pipe(Effect.ensuring(h.ready.open)),
        )
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
        assert.deepStrictEqual(
          (yield* h.service.start(event)).trace.map((t) => t.plugin),
          ["a"],
          "settled: no wait and no note",
        )
      }),
    ),
  )

  it.effect("a teardown that never finishes does not block the reload", () =>
    host((h) =>
      Effect.gen(function* () {
        const sticky = Plugin.define({
          id: "sticky",
          effect: () => Effect.addFinalizer(() => Effect.sleep("1 hour")),
        })
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

  it.effect("a reload does not wait for a hook in flight, which finishes on the snapshot it started with", () =>
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
        yield* h.activate([])
        assert.deepStrictEqual(yield* takeEvents, ["close slow"])
        yield* Deferred.succeed(gate, undefined)
        assert.strictEqual((yield* Fiber.join(spawning)).model, "slow")
      }),
    ),
  )

  it.effect(
    "a reload does not cut short a machine hook in flight either: agent and machine hooks share one scope rule",
    () =>
      host((h) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const gate = yield* Deferred.make<void>()
          const slow = Plugin.define({
            id: "slow",
            effect: (ctx) =>
              ctx.machine.hook("connect", (e) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.andThen(Effect.sync(() => void e.notes.push({ message: "finished" }))),
                ),
              ),
          })
          yield* h.activate([candidate("slow", "1", slow)])
          const connecting = yield* Effect.forkChild(
            h.service.machine("connect", { name: "mb", target: "b-host", vibestd: "b-id", runtimes: [] }),
          )
          yield* Deferred.await(entered)
          yield* h.activate([])
          yield* Deferred.succeed(gate, undefined)
          assert.deepStrictEqual((yield* Fiber.join(connecting)).notes, [{ plugin: "slow", message: "finished" }])
        }),
      ),
  )
})

const counters = ((globalThis as { __vibestReload?: Record<string, number> }).__vibestReload ??= {})
const count = (key: string) => counters[key] ?? 0

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

const waiters = new Set<() => void>()
const wake = () => {
  for (const waiter of waiters) waiter()
}
const untilSignal = (ready: () => boolean, what: string) =>
  Effect.callback<void>((resume) => {
    const check = () => {
      if (!ready()) return
      waiters.delete(check)
      resume(Effect.void)
    }
    waiters.add(check)
    check()
    return Effect.sync(() => waiters.delete(check))
  }).pipe(Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.die(`gave up waiting for ${what}`) }))

const watchers = { open: 0 }
const watchGate: { hold: boolean; pending: Array<{ name: string; deliver: () => void }> } = { hold: false, pending: [] }
const vibestJsonReads = { count: 0 }
const nativeRequire = module.createRequire(import.meta.url)
const freshRequire = async (entry: string, files: ReadonlyArray<string>) => {
  for (const file of files) delete nativeRequire.cache[file]
  return nativeRequire(entry)
}
const loader: PluginLoader["Service"] = {
  ...Platform.plugins,
  prepare: Effect.void,
  parseJsonc: (text) => {
    vibestJsonReads.count++
    wake()
    return Platform.plugins.parseJsonc(text)
  },
  load: freshRequire,
  watch: (directory, changed) => {
    const stop = Platform.plugins.watch(directory, (name) => {
      if (watchGate.hold) watchGate.pending.push({ name, deliver: () => changed(name) })
      else changed(name)
      wake()
    })
    watchers.open++
    return () => {
      watchers.open--
      stop()
    }
  },
}

const packageHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const base = path.join(import.meta.dirname, ".tmp")
  yield* fs.makeDirectory(base, { recursive: true })
  const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ directory: base }))
  yield* fs.makeDirectory(path.join(dir, "plugins"))
  return dir
})

const supervise = (dir: string) =>
  Plugins.layer.pipe(
    Layer.provide(Layer.succeed(PluginLoader, loader)),
    Layer.provide(Layer.succeed(Builtins, [])),
    Layer.provide(subscriptionsLayer),
    Layer.provide(harnessesLayer()),
    Layer.provide(Layer.effect(Layout, Layout.make(dir))),
    Layer.provide(runtimesLayer),
    Layer.provide(Bus.layer),
    Layer.build,
    Effect.map(Context.get(Plugins)),
  )

const eventually = <A, E, R>(f: Effect.Effect<A, E, R>, done: (a: A) => boolean, what: string) =>
  f.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("20 millis"), times: 250 }),
    Effect.filterOrElse(done, (a) => Effect.die(`gave up waiting for ${what}: ${JSON.stringify(a)}`)),
  )
const timers = Effect.gen(function* () {
  const clock = yield* TestClock.testClockWith(Effect.succeed)
  const armed: Array<number> = []
  const sleep = (duration: Duration.Duration) =>
    Effect.suspend(() => {
      const ms = Duration.toMillis(duration)
      armed.push(ms)
      wake()
      return clock.sleep(duration).pipe(Effect.ensuring(Effect.sync(() => armed.splice(armed.indexOf(ms), 1))))
    })
  const fire = (duration: Duration.Input) => {
    const ms = Duration.toMillis(Duration.fromInputUnsafe(duration))
    return untilSignal(() => armed.includes(ms), `a ${ms} ms timer`).pipe(Effect.andThen(clock.adjust(ms)))
  }
  const clocked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Clock.Clock, Object.assign(Object.create(clock) as TestClock.TestClock, { sleep }))
  return { fire, clocked }
})
const pastDebounce = Effect.sleep("150 millis")
const pastRescan = Effect.suspend(() => {
  const start = vibestJsonReads.count
  return untilSignal(() => vibestJsonReads.count > start, "a rescan")
})

const live = <E>(
  name: string,
  program: Effect.Effect<void, E, FileSystem.FileSystem | Path.Path | Crypto.Crypto | Scope.Scope>,
) => it.live(name, () => program.pipe(Effect.scoped, Effect.provide(Platform.services)), { timeout: 20_000 })

describe("plugins: supervisor", () => {
  live(
    "a dependency edit (atomic save) reloads the changed transitive import, without touching the entry",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* packageHome
      yield* fs.makeDirectory(path.join(dir, "lib"))
      yield* fs.writeFileString(path.join(dir, "lib", "value.ts"), `export const value = "v1"\n`)
      yield* fs.writeFileString(
        path.join(dir, "plugins", "dep.ts"),
        pluginFile("dep", "dep", "value", `import { value } from "../lib/value.ts"`),
      )
      const plugins = yield* supervise(dir)
      assert.strictEqual((yield* plugins.start(event)).model, "v1")
      const [before] = yield* plugins.list
      yield* fs.writeFileString(path.join(dir, "lib", "value.ts.tmp"), `export const value = "v2"\n`)
      yield* fs.rename(path.join(dir, "lib", "value.ts.tmp"), path.join(dir, "lib", "value.ts"))
      yield* eventually(plugins.start(event), (s) => s.model === "v2", "the new dependency value")
      const [after] = yield* plugins.list
      assert.notStrictEqual(after!.revision, before!.revision)
      assert.strictEqual(count("import:dep"), 2)
    }),
  )

  live(
    "P17/P18: a burst of saves ends on the last one; a broken save keeps the old plugin, unrelated saves do not re-import it, a fix recovers",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* packageHome
      const file = path.join(dir, "plugins", "p.ts")
      const other = path.join(dir, "plugins", "q.ts")
      yield* fs.writeFileString(file, pluginFile("p", "p", `"p0"`))
      yield* fs.writeFileString(other, pluginFile("q", "q", "e.model"))
      const plugins = yield* supervise(dir)
      assert.strictEqual((yield* plugins.start(event)).model, "p0")

      for (let i = 1; i <= 10; i++) {
        yield* fs.writeFileString(file, pluginFile("p", "p", `"p${i}"`))
      }
      yield* eventually(plugins.start(event), (s) => s.model === "p10", "the last save")

      yield* fs.writeFileString(file, `globalThis.__vibestReload["import:p"]++\nthrow new Error("broken on purpose")\n`)
      const listed = yield* eventually(plugins.list, (l) => l[0]?.error !== undefined, "the import error")
      assert.deepInclude(listed[0], { id: "p", status: "active" })
      assert.include(listed[0]!.error, "broken on purpose")
      assert.strictEqual((yield* plugins.start(event)).model, "p10", "the last working revision still runs")
      const brokenImports = count("import:p")

      yield* fs.writeFileString(other, pluginFile("q", "q", `"q1"`))
      yield* eventually(plugins.start(event), (s) => s.model === "q1", "q's new revision")
      const firstFile = path.join(dir, "plugins", "a.ts")
      yield* fs.writeFileString(firstFile, pluginFile("a", "a", "e.model"))
      yield* eventually(plugins.list, (l) => l.length === 3, "a new first plugin")
      yield* pastDebounce
      assert.strictEqual(
        count("import:p"),
        brokenImports,
        "a broken revision is not imported again while unchanged, though a.ts sorting before it rebuilt p",
      )

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
      const dir = yield* packageHome
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
      const dir = yield* packageHome
      yield* fs.makeDirectory(path.join(dir, "x"))
      yield* fs.writeFileString(path.join(dir, "x", "index.ts"), pluginFile("x", "x", `"x"`))
      const config = path.join(dir, "vibest.json")
      yield* fs.writeFileString(config, `{ "plugins": ["./x"] }`)
      const scope = yield* Scope.make()
      const before = watchers.open
      const plugins = yield* supervise(dir).pipe(Scope.provide(scope))
      assert.strictEqual((yield* plugins.start(event)).model, "x")
      assert.strictEqual(watchers.open - before, 3, "watched: home (vibest.json, plugins), plugins/ and x/")

      yield* fs.writeFileString(config, `{ "plugins": ["./x", `)
      yield* pastDebounce
      assert.strictEqual((yield* plugins.start(event)).model, "x", "a half-saved vibest.json changes nothing")

      const setups = count("setup:x")
      yield* fs.writeFileString(path.join(dir, "vibest.db"), "churn")
      yield* pastDebounce
      assert.strictEqual(count("setup:x"), setups, "unrelated files in VIBEST_HOME reload nothing")

      yield* fs.writeFileString(config, `{ "plugins": [] }`)
      yield* eventually(plugins.list, (l) => l.length === 0, "x removed")
      assert.strictEqual(watchers.open - before, 2, "x/ is no longer watched")
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual(watchers.open, before, "vibestd's end closes every watcher")
    }),
  )

  live(
    "an old runtime key warns once and is otherwise ignored",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* packageHome
      const logs: Array<string> = []
      yield* fs.writeFileString(path.join(dir, "vibest.json"), '{ "runtime": "hc", "plugins": [] }\n')
      const plugins = yield* supervise(dir).pipe(
        Effect.provide(Logger.layer([Logger.make((entry) => void logs.push(String(entry.message)))])),
      )
      assert.strictEqual((yield* plugins.start(event)).runtime, undefined)
      const warnings = () => logs.filter((line) => line.includes('"runtime" is ignored'))
      assert.strictEqual(warnings().length, 1)
      const reads = vibestJsonReads.count
      yield* fs.writeFileString(path.join(dir, "vibest.json"), '{ "runtime": "herdr", "plugins": [] }\n')
      yield* pastRescan
      assert.isAbove(vibestJsonReads.count, reads)
      assert.strictEqual(warnings().length, 1)
    }),
  )

  live(
    "a spawn right after start waits for the first activation instead of running without plugins",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* packageHome
      yield* fs.writeFileString(path.join(dir, "plugins", "early.ts"), pluginFile("early", "early", `"early"`))
      const s = yield* (yield* supervise(dir)).start(event)
      assert.deepStrictEqual(
        s.trace.map((t) => [t.plugin, t.outcome]),
        [["early", "ok"]],
      )
      assert.strictEqual(s.model, "early")
    }),
  )

  live(
    "a builtin runtime is registered once the layer is built, before vibestd admits a request that routes to it",
    Effect.gen(function* () {
      const dir = yield* packageHome
      const runtimePlugin: Candidate = candidate(
        "builtin:runtime-fake",
        "1",
        Plugin.define({
          id: "runtime-fake",
          effect: (ctx) =>
            ctx.runtime.transform((editor) =>
              editor.add({ id: "fake", events: Stream.empty } as unknown as Runtime.RuntimeDefinition),
            ),
        }),
      )
      const built = yield* Plugins.layer.pipe(
        Layer.provide(Layer.succeed(PluginLoader, loader)),
        Layer.provide(Layer.succeed(Builtins, [runtimePlugin])),
        Layer.provide(subscriptionsLayer),
        Layer.provide(harnessesLayer()),
        Layer.provide(Layer.effect(Layout, Layout.make(dir))),
        Layer.provideMerge(runtimesLayer),
        Layer.provide(Bus.layer),
        Layer.build,
      )
      const routed = yield* Context.get(built, Runtimes).route("fake")
      assert.strictEqual(routed.id, "fake")
    }),
  )

  live(
    "H2: under a symlinked VIBEST_HOME, a plugin added after start loads (and an edit of it reloads)",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const real = yield* packageHome
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
      const dir = yield* packageHome
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
      const dir = yield* packageHome
      yield* fs.writeFileString(path.join(dir, "vibest.json"), `{ "plugins": ["./later/x"] }`)
      const plugins = yield* supervise(dir)
      assert.deepStrictEqual(yield* plugins.list, [])
      yield* pastRescan
      yield* fs.makeDirectory(path.join(dir, "later", "x"), { recursive: true })
      yield* fs.writeFileString(path.join(dir, "later", "x", "index.ts"), pluginFile("x", "later-x", `"x"`))
      yield* eventually(plugins.list, (l) => l[0]?.status === "active", "the new directory plugin")
      assert.strictEqual((yield* plugins.start(event)).model, "x")
    }),
  )

  it.effect(
    "a change the watcher dropped right after a watch closed (as Bun sometimes does on macOS) is found by the one rescan, which then stops",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* packageHome
        const plugins = path.join(dir, "plugins")
        yield* fs.writeFileString(path.join(dir, "vibest.json"), `{}`)
        yield* fs.writeFileString(path.join(plugins, "a.ts"), pluginFile("a", "drop-a", `"a1"`))
        yield* fs.makeDirectory(path.join(plugins, "d"))
        yield* fs.writeFileString(path.join(plugins, "d", "index.ts"), pluginFile("d", "drop-d", "e.model"))
        watchGate.hold = true
        watchGate.pending = []
        const { fire, clocked } = yield* timers
        const service = yield* clocked(supervise(dir))
        assert.strictEqual((yield* service.list).length, 2)
        const startReads = vibestJsonReads.count
        yield* fire(RECHECK)
        yield* fire(DEBOUNCE)
        yield* service.settled
        assert.isAbove(vibestJsonReads.count, startReads, "the rescan after the first watch")
        const deliver = () => {
          for (const change of watchGate.pending.splice(0)) change.deliver()
        }
        yield* fs.remove(path.join(plugins, "d"), { recursive: true })
        yield* untilSignal(() => watchGate.pending.length > 0, "the watcher to see d go")
        deliver()
        yield* fire(DEBOUNCE)
        yield* service.settled
        const removed = yield* service.list
        assert.deepStrictEqual(
          removed.map((p) => p.id),
          ["a"],
        )
        const afterRemoval = vibestJsonReads.count
        yield* fs.writeFileString(path.join(plugins, "a.ts"), pluginFile("a", "drop-a", `"a2"`))
        yield* untilSignal(() => watchGate.pending.some((c) => c.name === "a.ts"), "the watcher to see the save")
        watchGate.pending.splice(0)
        assert.strictEqual((yield* service.start(event)).model, "a1", "the dropped save is not seen yet")
        yield* fire(RECHECK)
        yield* fire(DEBOUNCE)
        assert.strictEqual((yield* service.start(event)).model, "a2", "the rescan finds the save")
        assert.isAbove(vibestJsonReads.count, afterRemoval)
        const settled = vibestJsonReads.count
        yield* TestClock.adjust("1 minute")
        yield* TestClock.withLive(Effect.sleep("100 millis"))
        assert.strictEqual(vibestJsonReads.count, settled, "one rescan per change of the watched set, not polling")
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
    20_000,
  )

  it.effect(
    "P19: a change during a stuck activation keeps readiness closed until that change is active too (z's duplicate events stay held while the debounce clock is frozen)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* packageHome
        const entered = ((globalThis as { __vibestStuck?: { value: boolean; wake: () => void } }).__vibestStuck = {
          value: false,
          wake,
        })
        watchGate.hold = true
        watchGate.pending = []
        const stuckA = `import { Plugin } from "@vibest/plugin"\nimport { Effect } from "effect"\nexport default Plugin.define({ id: "a", effect: () => Effect.sync(() => { globalThis.__vibestStuck.value = true; globalThis.__vibestStuck.wake() }).pipe(Effect.andThen(Effect.uninterruptible(Effect.sleep("6 seconds")))) })\n`
        yield* fs.writeFileString(path.join(dir, "plugins", "a.ts"), stuckA)
        yield* fs.writeFileString(path.join(dir, "plugins", "z.ts"), pluginFile("z", "pending-z", `"z1"`))
        const plugins = yield* supervise(dir)
        yield* untilSignal(() => entered.value, "a's setup to start")
        yield* fs.writeFileString(path.join(dir, "plugins", "z.ts"), pluginFile("z", "pending-z", `"z2"`))
        yield* untilSignal(
          () => watchGate.pending.some((change) => change.name === "z.ts"),
          "the watcher to observe z.ts (a fixed sleep moves the frozen clock too soon or past the 10s budget)",
        )
        const deliverZ = () => {
          for (const change of watchGate.pending.splice(0)) if (change.name === "z.ts") change.deliver()
        }
        deliverZ()
        const spawning = yield* Effect.forkChild(plugins.start(event))
        yield* TestClock.adjust("6 seconds")
        assert.isUndefined(spawning.pollUnsafe(), "readiness opened on the pre-change activation")
        yield* TestClock.adjust("200 millis")
        const s = yield* TestClock.withLive(Fiber.join(spawning).pipe(Effect.timeout("5 seconds")))
        assert.strictEqual(s.model, "z2")
        assert.deepStrictEqual(
          s.trace.map((t) => t.plugin),
          ["z"],
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
