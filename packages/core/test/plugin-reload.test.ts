import module from "node:module"

import { assert, describe, it } from "@effect/vitest"
import { Agents } from "@vibest/core/agents"
import { Bus } from "@vibest/core/bus"
import { Layout } from "@vibest/core/paths"
import {
  Builtins,
  type Candidate,
  DEBOUNCE,
  makeHost,
  PluginLoader,
  Plugins,
  PluginsNotActive,
  RECHECK,
} from "@vibest/core/plugin"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { Plugin } from "@vibest/plugin/effect"
import { Clock, Context, Duration, Deferred, Effect, Fiber, FileSystem, Layer, Path, Schedule } from "effect"
import { TestClock } from "effect/testing"

import * as Platform from "../../platform-bun/src/bun.ts"
import { runtimesLayer, subscriptionsLayer, harnessesLayer } from "./lib/harnesses.ts"

const events: Array<string> = []
const logged = (id: string, tag: string, setup: Effect.Effect<void> = Effect.void) =>
  Plugin.define({
    id,
    effect: (ctx) =>
      Effect.gen(function* () {
        events.push(`setup ${tag}`)
        yield* Effect.addFinalizer(() => Effect.sync(() => events.push(`close ${tag}`)))
        yield* ctx.agent.hook("start.before", () => Effect.succeed({ model: tag }))
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
const c1 = candidate("c", "1", logged("c", "c1"))

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
  harnesses: [
    { harness: "pi", available: true },
    { harness: "claude", available: true },
    { harness: "cursor", available: true },
  ],
}
const takeEvents = Effect.sync(() => events.splice(0))

const host = <A, E>(
  f: (host: Effect.Success<ReturnType<typeof makeHost>>) => Effect.Effect<A, E>,
  timeout?: Duration.Input,
) =>
  makeHost(timeout === undefined ? {} : { timeout }).pipe(
    Effect.flatMap(f),
    Effect.scoped,
    Effect.provide(subscriptionsLayer),
    Effect.provide(harnessesLayer()),
    Effect.provide(runtimesLayer),
    Effect.provide(Agents.layer),
    Effect.provide(Bus.layer),
  )

describe("plugins: activation", () => {
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

  it.effect(
    "P17: a revision that fails to import with changed options is failed; the old one is not kept or restored",
    () =>
      host((h) =>
        Effect.gen(function* () {
          yield* h.activate([a1, b1])
          yield* takeEvents
          yield* h.activate([candidate("a", "2", { error: "import failed: SyntaxError" }, { level: 2 }), b1])
          assert.deepStrictEqual(yield* takeEvents, ["close b1", "close a1", "setup b1"])
          const [a, b] = yield* h.service.list
          assert.deepInclude(a, { status: "failed", revision: "2" })
          assert.strictEqual(a!.error, "import failed: SyntaxError")
          assert.deepInclude(b, { id: "b", status: "active" })
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
              yield* ctx.agent.hook("start.before", () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.as({ model: "slow" }),
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
              ctx.machine.hook("connect", () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.as([{ message: "finished" }]),
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
import { Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"
const c = (globalThis.__vibestReload ??= {})
c["import:${key}"] = (c["import:${key}"] ?? 0) + 1
export default Plugin.define({
  id: ${JSON.stringify(id)},
  effect: (ctx) => Effect.sync(() => { c["setup:${key}"] = (c["setup:${key}"] ?? 0) + 1 }).pipe(Effect.andThen(ctx.agent.hook("start.before", (e) => Effect.succeed({ model: ${model} })))),
})
`

const fsEventsDeliveryUnderLoad = Duration.seconds(60)
const waiters = new Set<() => void>()
const wake = () => {
  for (const waiter of waiters) waiter()
}
const untilSignal = (ready: () => boolean, what: string, within: Duration.Input = "10 seconds") =>
  Effect.callback<void>((resume) => {
    const check = () => {
      if (!ready()) return
      waiters.delete(check)
      resume(Effect.void)
    }
    waiters.add(check)
    check()
    return Effect.sync(() => waiters.delete(check))
  }).pipe(Effect.timeoutOrElse({ duration: within, orElse: () => Effect.die(`gave up waiting for ${what}`) }))

const watchers = { open: 0, opened: 0 }
const watchGate: {
  hold: boolean
  listeners: Map<string, (name: string) => void>
  failures: Map<string, (error: Error) => void>
} = {
  hold: false,
  listeners: new Map(),
  failures: new Map(),
}
const watchSees = (directory: string, name: string) => Effect.sync(() => watchGate.listeners.get(directory)!(name))
const vibestJsonReads = { count: 0 }
type ConfigPause = {
  on: boolean
  gate: Promise<void>
  release: () => void
  blocked: boolean
  mark: boolean
  reads: number[]
}
const pausingConfigReads = (fs: FileSystem.FileSystem, config: string, pause: ConfigPause): FileSystem.FileSystem => {
  const readConfig = (path: string, encoding?: string): ReturnType<FileSystem.FileSystem["readFileString"]> => {
    const read = () => {
      if (pause.mark && path === config) pause.reads.push(Date.now())
      return fs.readFileString(path, encoding)
    }
    if (!pause.on || path !== config) return read()
    pause.blocked = true
    const waiting = pause.gate
    return Effect.promise(() => waiting).pipe(
      Effect.andThen(() => {
        pause.blocked = false
        return read()
      }),
    )
  }
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === "readFileString") return readConfig
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
const nativeRequire = module.createRequire(import.meta.url)
const freshRequire = async (entry: string, files: ReadonlyArray<string>) => {
  for (const file of files) delete nativeRequire.cache[file]
  return nativeRequire(entry)
}
const makeLoader = (): PluginLoader["Service"] => {
  const platform = Platform.makePluginLoader()
  return {
    ...platform,
    prepare: Effect.void,
    parseJsonc: (text) => {
      vibestJsonReads.count++
      wake()
      return platform.parseJsonc(text)
    },
    load: async (entry, files) => {
      const marker = /hold-import:(\w+)/.exec(await Bun.file(entry).text())?.[1]
      const gate = (
        globalThis as {
          __vibestHoldImport?: { entered: Set<string>; promise: Promise<void>; wake: () => void }
        }
      ).__vibestHoldImport
      if (marker !== undefined && gate !== undefined) {
        gate.entered.add(marker)
        gate.wake()
        await gate.promise
      }
      return freshRequire(entry, files)
    },
    watch: (directory, changed, failed) => {
      watchGate.listeners.set(directory, changed)
      watchGate.failures.set(directory, failed)
      const stop = platform.watch(
        directory,
        (name) => {
          if (!watchGate.hold) changed(name)
        },
        failed,
      )
      watchers.open++
      watchers.opened++
      return () => {
        watchers.open--
        stop()
      }
    },
  }
}

const packageHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ directory: import.meta.dirname, prefix: ".tmp-" }))
  yield* fs.makeDirectory(path.join(dir, "plugins"))
  return dir
})

const supervise = (dir: string, builtins: ReadonlyArray<Candidate> = []) =>
  Plugins.layer.pipe(
    Layer.provide(Layer.sync(PluginLoader, makeLoader)),
    Layer.provide(Layer.succeed(Builtins, builtins)),
    Layer.provide(subscriptionsLayer),
    Layer.provide(harnessesLayer()),
    Layer.provide(Layer.effect(Layout, Layout.make(dir))),
    Layer.provide(runtimesLayer),
    Layer.provide(Agents.layer),
    Layer.provide(Bus.layer),
    Layer.build,
    Effect.map(Context.get(Plugins)),
  )

const eventually = <A, E, R>(f: Effect.Effect<A, E, R>, done: (a: A) => boolean, what: string) =>
  f.pipe(
    Effect.repeat({
      until: done,
      schedule: Schedule.spaced("20 millis").pipe(Schedule.upTo({ duration: fsEventsDeliveryUnderLoad })),
    }),
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
  const isArmed = (duration: Duration.Input) => {
    const ms = Duration.toMillis(Duration.fromInputUnsafe(duration))
    return untilSignal(() => armed.includes(ms), `a ${ms} ms timer`)
  }
  const fire = (duration: Duration.Input) =>
    isArmed(duration).pipe(Effect.andThen(clock.adjust(Duration.fromInputUnsafe(duration))))
  const clocked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Clock.Clock, Object.assign(Object.create(clock) as TestClock.TestClock, { sleep }))
  const rescanned = <A, E, R>(f: Effect.Effect<A, E, R>, done: (a: A) => boolean, what: string) =>
    isArmed(RECHECK).pipe(
      Effect.andThen(clock.adjust(RECHECK)),
      Effect.andThen(TestClock.withLive(eventually(clock.adjust(DEBOUNCE).pipe(Effect.andThen(f)), done, what))),
    )
  return { armed: isArmed, fire, clocked, rescanned }
})
describe("plugins: supervisor", () => {
  const builtinCandidate = (id: string) =>
    candidate(
      `builtin:${id}`,
      id,
      Plugin.define({ id, effect: (ctx) => ctx.agent.hook("start.before", () => Effect.succeed(undefined)) }),
    )
  const startedWith = (plugins: Plugins["Service"]) =>
    plugins.start(event).pipe(Effect.map((s) => s.trace.map((t) => t.plugin)))

  it.effect(
    "P1: -<id> removes a builtin by exact id, -* and -prefix.* never match builtins, and un-removing needs no restart",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* packageHome
        const config = path.join(dir, "vibest.json")
        const builtins = [builtinCandidate("harness-x"), builtinCandidate("runtime-y"), builtinCandidate("runtime-z")]
        yield* fs.writeFileString(config, `{ "plugins": ["-*", "-runtime.*", "-runtime-*", "-harness-x"] }`)
        const plugins = yield* TestClock.withLive(supervise(dir, builtins))
        const active = plugins.list.pipe(
          Effect.map((rows) =>
            rows
              .filter((row) => row.status === "active")
              .map((row) => row.id)
              .sort()
              .join(),
          ),
        )
        const untilActive = (want: string, what: string) =>
          TestClock.withLive(eventually(active, (ids) => ids === want, what))
        yield* untilActive("runtime-y,runtime-z", "the kept builtins")
        assert.deepStrictEqual(yield* TestClock.withLive(startedWith(plugins)), ["runtime-y", "runtime-z"])
        yield* fs.writeFileString(config, `{ "plugins": ["-runtime-y", "-harness-x"] }`)
        yield* untilActive("runtime-z", "runtime-y removed")
        assert.deepStrictEqual(yield* TestClock.withLive(startedWith(plugins)), ["runtime-z"])
        yield* fs.writeFileString(config, `{ "plugins": [] }`)
        yield* untilActive("harness-x,runtime-y,runtime-z", "the builtins back")
        assert.deepStrictEqual(yield* TestClock.withLive(startedWith(plugins)), ["harness-x", "runtime-y", "runtime-z"])
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    20_000,
  )

  it.effect(
    "a save the watch never reports is found by the next periodic rescan, and an unchanged rescan sets nothing up again",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* packageHome
        const file = path.join(dir, "plugins", "a.ts")
        yield* fs.writeFileString(path.join(dir, "vibest.json"), `{}`)
        yield* fs.writeFileString(file, pluginFile("a", "unreported-a", `"a1"`))
        watchGate.hold = true
        const service = yield* TestClock.withLive(supervise(dir))
        const model = TestClock.withLive(service.start(event).pipe(Effect.map((s) => s.model)))
        if (!(yield* TestClock.withLive(service.settled))) return yield* Effect.die("activation did not settle")
        assert.strictEqual(yield* model, "a1")
        yield* fs.writeFileString(file, pluginFile("a", "unreported-a", `"a2"`))
        yield* TestClock.withLive(
          eventually(
            Effect.sync(() => count("setup:unreported-a")),
            (n) => n >= 2,
            "the unreported save",
          ),
        )
        assert.strictEqual(yield* model, "a2")
        const reads = vibestJsonReads.count
        yield* TestClock.withLive(
          eventually(
            Effect.sync(() => vibestJsonReads.count),
            (n) => n > reads,
            "a rescan with nothing changed",
          ),
        )
        yield* TestClock.withLive(Effect.sleep("200 millis"))
        assert.strictEqual(count("setup:unreported-a"), 2)
      }).pipe(
        Effect.ensuring(Effect.sync(() => void (watchGate.hold = false))),
        Effect.scoped,
        Effect.provide(Platform.services),
      ),
    20_000,
  )

  it.effect(
    "a burst during the delay keeps readiness closed until that pass imports an unreported edit",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* packageHome
        const pluginsDir = path.join(dir, "plugins")
        const file = path.join(pluginsDir, "a.ts")
        yield* fs.writeFileString(path.join(dir, "vibest.json"), `{}`)
        yield* fs.writeFileString(file, pluginFile("a", "burst-a", `"a1"`))
        watchGate.hold = true
        const service = yield* TestClock.withLive(supervise(dir))
        assert.strictEqual((yield* TestClock.withLive(service.start(event))).model, "a1")
        yield* watchSees(pluginsDir, "a.ts")
        yield* watchSees(pluginsDir, "a.ts")
        yield* fs.writeFileString(file, pluginFile("a", "burst-a", `"a2"`))
        const starting = yield* Effect.forkChild(TestClock.withLive(service.start(event)))
        yield* TestClock.withLive(Effect.sleep("20 millis"))
        assert.isUndefined(starting.pollUnsafe(), "a start was admitted before the burst settled")
        const started = yield* TestClock.withLive(Fiber.join(starting).pipe(Effect.timeout("5 seconds")))
        assert.strictEqual(started.model, "a2")
      }).pipe(
        Effect.ensuring(Effect.sync(() => void (watchGate.hold = false))),
        Effect.scoped,
        Effect.provide(Platform.services),
      ),
    20_000,
  )

  it.effect(
    "an otherwise unchanged rescan that outlasts the recheck reopens readiness",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* packageHome
        yield* fs.writeFileString(path.join(dir, "vibest.json"), `{}`)
        yield* fs.writeFileString(path.join(dir, "plugins", "a.ts"), pluginFile("a", "slow-scan-a", `"a1"`))
        const config = path.join(dir, "vibest.json")
        const pause: ConfigPause = {
          on: false,
          gate: Promise.resolve(),
          release: () => {},
          blocked: false,
          mark: false,
          reads: [],
        }
        const service = yield* TestClock.withLive(
          supervise(dir).pipe(Effect.provideService(FileSystem.FileSystem, pausingConfigReads(fs, config, pause))),
        )
        assert.strictEqual((yield* TestClock.withLive(service.start(event))).model, "a1")
        const setups = count("setup:slow-scan-a")
        watchGate.hold = true
        pause.on = true
        pause.gate = new Promise<void>((resolve) => {
          pause.release = resolve
        })
        yield* TestClock.withLive(
          eventually(
            Effect.sync(() => pause.blocked),
            (blocked) => blocked,
            "the rescan to start reading",
          ),
        )
        const starting = yield* Effect.forkChild(TestClock.withLive(service.start(event)))
        yield* TestClock.withLive(Effect.sleep(RECHECK))
        yield* TestClock.withLive(Effect.sleep("100 millis"))
        assert.isUndefined(starting.pollUnsafe(), "the recheck during the slow rescan reopened readiness")
        pause.mark = true
        pause.on = false
        pause.release()
        const started = yield* TestClock.withLive(Fiber.join(starting).pipe(Effect.timeout("5 seconds")))
        assert.strictEqual(started.model, "a1")
        assert.strictEqual(count("setup:slow-scan-a"), setups)
        const gap = pause.reads.slice(1).reduce((widest, at, i) => Math.max(widest, at - pause.reads[i]!), 0)
        assert.ok(gap < 80, `a rescan tick scheduled another reload: ${pause.reads.join(",")}`)
      }).pipe(
        Effect.ensuring(Effect.sync(() => void (watchGate.hold = false))),
        Effect.scoped,
        Effect.provide(Platform.services),
      ),
    20_000,
  )

  it.effect(
    "a watcher that fails is set up again by the next rescan",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* packageHome
        yield* fs.writeFileString(path.join(dir, "vibest.json"), `{}`)
        yield* fs.writeFileString(path.join(dir, "plugins", "a.ts"), pluginFile("a", "rearm-a", `"a1"`))
        const { clocked, rescanned } = yield* timers
        const service = yield* clocked(supervise(dir))
        yield* service.start(event)
        const opened = watchers.opened
        watchGate.failures.get(path.join(dir, "plugins"))!(new Error("EMFILE"))
        yield* rescanned(
          Effect.sync(() => watchers.opened),
          (n) => n > opened,
          "the watch to be set up again",
        )
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
    20_000,
  )

  it.effect(
    "an agent start during a periodic reload that found a change waits for the new revision's hooks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* packageHome
        const file = path.join(dir, "plugins", "a.ts")
        yield* fs.writeFileString(file, pluginFile("a", "gated-a", `"a1"`))
        watchGate.hold = true
        const gate = { entered: false, release: () => {} }
        const released = new Promise<void>((resolve) => (gate.release = resolve))
        Object.assign(globalThis, { __vibestGate: { gate, released } })
        const { clocked, rescanned } = yield* timers
        const service = yield* clocked(supervise(dir))
        assert.strictEqual((yield* service.start(event)).model, "a1")
        yield* fs.writeFileString(
          file,
          `import { Plugin } from "@vibest/plugin/effect"\nimport { Effect } from "effect"\nexport default Plugin.define({ id: "a", effect: (ctx) => Effect.promise(() => { globalThis.__vibestGate.gate.entered = true; return globalThis.__vibestGate.released }).pipe(Effect.andThen(ctx.agent.hook("start.before", () => Effect.succeed({ model: "a2" })))) })\n`,
        )
        yield* rescanned(
          Effect.sync(() => gate.entered),
          (entered) => entered,
          "the new revision's setup",
        )
        const starting = yield* Effect.forkChild(service.start(event))
        yield* TestClock.withLive(Effect.sleep("200 millis"))
        assert.isUndefined(starting.pollUnsafe(), "the start waits while the new revision sets up")
        gate.release()
        const started = yield* TestClock.withLive(Fiber.join(starting).pipe(Effect.timeout("5 seconds")))
        assert.strictEqual(started.model, "a2")
      }).pipe(
        Effect.ensuring(Effect.sync(() => void (watchGate.hold = false))),
        Effect.scoped,
        Effect.provide(Platform.services),
      ),
    20_000,
  )

  it.effect(
    "P19: a change during a stuck activation keeps readiness closed until that change is active too",
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
        const stuckA = `import { Plugin } from "@vibest/plugin/effect"\nimport { Effect } from "effect"\nexport default Plugin.define({ id: "a", effect: () => Effect.sync(() => { globalThis.__vibestStuck.value = true; globalThis.__vibestStuck.wake() }).pipe(Effect.andThen(Effect.uninterruptible(Effect.sleep("6 seconds")))) })\n`
        yield* fs.writeFileString(path.join(dir, "plugins", "a.ts"), stuckA)
        yield* fs.writeFileString(path.join(dir, "plugins", "z.ts"), pluginFile("z", "pending-z", `"z1"`))
        const plugins = yield* supervise(dir)
        yield* untilSignal(() => entered.value, "a's setup to start")
        yield* fs.writeFileString(path.join(dir, "plugins", "z.ts"), pluginFile("z", "pending-z", `"z2"`))
        yield* watchSees(path.join(dir, "plugins"), "z.ts")
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
        Effect.ensuring(Effect.sync(() => void (watchGate.hold = false))),
        Effect.scoped,
        Effect.provide(Platform.services),
      ),
    15_000,
  )

  it.effect("a start during setup is refused and names the plugins still loading", () =>
    host(
      (h) =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const slow = Plugin.define({
            id: "slow",
            effect: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          })
          yield* Effect.sync(h.holdNow)
          const activating = yield* Effect.forkChild(
            h.activate([candidate("slow", "1", slow), candidate("later", "1", logged("later", "later"))]),
          )
          yield* Deferred.await(entered)
          const starting = yield* Effect.forkChild(h.service.start(event))
          yield* TestClock.adjust("10 seconds")
          const failed = yield* Effect.flip(Fiber.join(starting))
          assert.ok(failed instanceof PluginsNotActive)
          assert.deepStrictEqual(failed.plugins, ["slow", "later"])
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(activating)
        }),
      "30 seconds",
    ),
  )

  const blockedSubscriptions = (entered: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
    Layer.succeed(
      Subscriptions,
      Subscriptions.of({
        list: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as([])),
        report: () => Effect.void,
        poll: Effect.void,
      }),
    )

  it.effect("a reload while subscriptions are read keeps the hooks captured with readiness", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* makeHost().pipe(
        Effect.flatMap((h) =>
          Effect.gen(function* () {
            yield* h.activate([candidate("a", "1", logged("a", "a1"))])
            const starting = yield* Effect.forkChild(h.service.start(event))
            yield* Deferred.await(entered)
            yield* h.activate([])
            yield* Deferred.succeed(release, undefined)
            assert.deepStrictEqual(
              (yield* Fiber.join(starting)).trace.map((t) => t.plugin),
              ["a"],
            )
          }),
        ),
        Effect.scoped,
        Effect.provide(blockedSubscriptions(entered, release)),
        Effect.provide(harnessesLayer()),
        Effect.provide(runtimesLayer),
        Effect.provide(Agents.layer),
        Effect.provide(Bus.layer),
      )
    }),
  )

  it.effect("a reload while subscriptions are read keeps the fail hook captured with readiness", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const failing = Plugin.define({
        id: "a",
        effect: (ctx) => ctx.agent.hook("fail", () => Effect.succeed({ harness: "pi" })),
      })
      yield* makeHost().pipe(
        Effect.flatMap((h) =>
          Effect.gen(function* () {
            yield* h.activate([candidate("a", "1", failing)])
            const moved = yield* Effect.forkChild(
              h.service.fail({
                project: "/r",
                agent: "general",
                parentSessionId: undefined,
                harnesses: event.harnesses,
                attempts: [],
                sessionId: "s",
                reason: "limited",
                error: "limited",
                input: "p",
                harness: "claude",
                provider: undefined,
              }),
            )
            yield* Deferred.await(entered)
            yield* h.activate([])
            yield* Deferred.succeed(release, undefined)
            assert.strictEqual((yield* Fiber.join(moved)).move?.harness, "pi")
          }),
        ),
        Effect.scoped,
        Effect.provide(blockedSubscriptions(entered, release)),
        Effect.provide(harnessesLayer()),
        Effect.provide(runtimesLayer),
        Effect.provide(Agents.layer),
        Effect.provide(Bus.layer),
      )
    }),
  )

  it.effect(
    "a rescan that finds a plugin without a watch notification keeps readiness closed while it imports",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* packageHome
        const entered = new Set<string>()
        let releaseImport = () => {}
        const held = new Promise<void>((resolve) => {
          releaseImport = resolve
        })
        ;(
          globalThis as {
            __vibestHoldImport?: { entered: Set<string>; promise: Promise<void>; wake: () => void }
          }
        ).__vibestHoldImport = { entered, promise: held, wake }
        yield* fs.writeFileString(path.join(dir, "plugins", "a.ts"), pluginFile("a", "scan-a", '"a1"'))
        watchGate.hold = true
        const { clocked, rescanned, armed } = yield* timers
        const service = yield* clocked(supervise(dir))
        assert.strictEqual((yield* service.start(event)).model, "a1")
        yield* fs.writeFileString(
          path.join(dir, "plugins", "b.ts"),
          "// hold-import:b\n" + pluginFile("b", "scan-b", '"b1"'),
        )
        yield* rescanned(
          Effect.sync(() => entered.has("b")),
          (seen) => seen,
          "b's import",
        )
        const starting = yield* clocked(Effect.forkChild(service.start(event)))
        yield* armed(Duration.seconds(10))
        assert.isUndefined(starting.pollUnsafe(), "the start ran while b was still importing")
        const listed = yield* service.list
        assert.ok(listed.some((plugin) => plugin.id === "a" && plugin.status === "active"))
        assert.ok(!listed.some((plugin) => plugin.id === "b"))
        releaseImport()
        const started = yield* TestClock.withLive(Fiber.join(starting).pipe(Effect.timeout("5 seconds")))
        assert.deepStrictEqual(started.trace.map((t) => t.plugin).sort(), ["a", "b"])
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            watchGate.hold = false
            ;(globalThis as { __vibestHoldImport?: unknown }).__vibestHoldImport = undefined
          }),
        ),
        Effect.scoped,
        Effect.provide(Platform.services),
      ),
    20_000,
  )
})
