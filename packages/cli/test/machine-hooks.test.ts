import { assert, describe, it } from "@effect/vitest"
import type { RuntimeDefinition } from "@vibest/core/host"
import { MACHINE_TIMEOUT, Plugins } from "@vibest/core/plugins"
import { Runtimes } from "@vibest/core/runtimes"
import { Plugin, type Registration } from "@vibest/plugin"
import { machineHooks } from "@vibest/plugin/testing"
import { Duration, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"

import { PluginHost, testLayer, type TestOptions, type TestServices, yieldToIo } from "./fakes.ts"

const event = { name: "mb", target: "b-host", vibestd: "b-id", runtimes: [] }

const noting = (id: string, message: string, runtime?: string) =>
  Plugin.define({
    id,
    effect: (ctx) =>
      Effect.gen(function* () {
        const options = runtime === undefined ? undefined : { runtime }
        yield* ctx.machine.hook(
          "connect",
          (e) => Effect.sync(() => e.notes.push({ message, fix: `fix ${id}` })),
          options,
        )
        yield* ctx.machine.hook(
          "remove",
          (e) => Effect.sync(() => e.notes.push({ message: `removed by ${id}` })),
          options,
        )
      }),
  })

const crashing = Plugin.define({
  id: "crashing",
  effect: (ctx) => ctx.machine.hook("connect", () => Effect.die(new Error("boom"))),
})

const hanging = Plugin.define({
  id: "hanging",
  effect: (ctx) => ctx.machine.hook("connect", () => Effect.never),
})

const unknown = Plugin.define({
  id: "unknown",
  effect: (ctx) => ctx.machine.hook("nope" as "connect", () => Effect.void),
})

const runtimeOwner = (id: string, runtime: string) => {
  const definition: RuntimeDefinition = {
    id: runtime,
    status: () => Effect.succeed({ status: "online" as const }),
    open: () => Effect.die(new Error("unused")),
    send: () => Effect.die(new Error("unused")),
    read: () => Effect.die(new Error("unused")),
    process: () => Effect.die(new Error("unused")),
    close: () => Effect.die(new Error("unused")),
    events: Stream.never,
  }
  return Plugin.define({ id, effect: (ctx) => ctx.runtime.transform((editor) => editor.add(definition)) })
}

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices>, options: TestOptions) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer(options))))

describe("plugins: machine hooks", () => {
  test(
    "every subscriber runs after one crashes; notes are tagged in order; a runtime reaches its own hooks and unscoped ones; unknown names fail the load",
    Effect.gen(function* () {
      const plugins = yield* Plugins
      const fired = yield* plugins.machine("connect", event)
      assert.deepStrictEqual(fired.plugins, ["one", "crashing", "two"])
      assert.deepStrictEqual(fired.notes, [
        { plugin: "one", message: "first", fix: "fix one" },
        { plugin: "crashing", message: "plugin crashing crashed: boom" },
        { plugin: "two", message: "second", fix: "fix two" },
      ])
      assert.deepStrictEqual((yield* plugins.machine("connect", event, "view")).plugins, ["one", "crashing", "two"])
      assert.deepStrictEqual((yield* plugins.machine("connect", event, "other")).plugins, ["one", "crashing"])
      const removed = yield* plugins.machine("remove", event)
      assert.deepStrictEqual(
        removed.notes.map((n) => n.message),
        ["removed by one", "removed by two"],
      )
      const failed = (yield* plugins.list).find((p) => p.source === "test:unknown")
      assert.strictEqual(failed?.status, "failed")
      assert.include(failed?.error ?? "", 'unsupported hook "machine.nope"; supported: machine.connect, machine.remove')
    }),
    { plugins: [noting("one", "first"), crashing, noting("two", "second", "view"), unknown] },
  )

  test(
    "a subscriber is bounded by 30 s, not the host default, and the next one still runs",
    Effect.gen(function* () {
      const plugins = yield* Plugins
      const fiber = yield* Effect.forkChild(plugins.machine("connect", event))
      yield* yieldToIo
      yield* TestClock.adjust(Duration.seconds(10))
      yield* yieldToIo
      assert.isUndefined(fiber.pollUnsafe(), "still running after the 5 s host default")
      yield* TestClock.adjust(MACHINE_TIMEOUT)
      const fired = yield* Fiber.join(fiber)
      assert.match(fired.notes[0]!.message, /^plugin hanging timed out after 30/)
      assert.deepStrictEqual(fired.notes[1], { plugin: "one", message: "first", fix: "fix one" })
    }),
    { plugins: [hanging, noting("one", "first")] },
  )

  test(
    "the runtime registry names each runtime a commit adds or replaces, not the ones it keeps",
    Effect.gen(function* () {
      const runtimes = yield* Runtimes
      const seen: Array<ReadonlyArray<string>> = []
      const follow = yield* runtimes.added.pipe(
        Stream.runForEach((ids) => Effect.sync(() => seen.push(ids))),
        Effect.forkScoped,
      )
      yield* yieldToIo
      const host = yield* PluginHost
      yield* host.load([noting("a", "x")])
      yield* host.load([noting("a", "x"), runtimeOwner("b", "other")])
      yield* yieldToIo
      assert.deepStrictEqual(seen, [["other"]])
      yield* Fiber.interrupt(follow)
    }).pipe(Effect.scoped),
    { plugins: [runtimeOwner("viewer", "view")] },
  )

  const registrations: Array<Registration> = []
  const calls: Array<string> = []
  test(
    "a machine hook's dispose stops its callback before the plugin unloads, and a second dispose does nothing",
    Effect.gen(function* () {
      const plugins = yield* Plugins
      yield* plugins.machine("connect", event)
      assert.deepStrictEqual(calls, ["mb"])
      yield* registrations[0]!.dispose
      yield* registrations[0]!.dispose
      const fired = yield* plugins.machine("connect", event)
      assert.deepStrictEqual(calls, ["mb"])
      assert.deepStrictEqual(fired.plugins, [])
      assert.strictEqual((yield* plugins.list).find((p) => p.id === "disposing")?.status, "active")
    }),
    {
      plugins: [
        Plugin.define({
          id: "disposing",
          effect: (ctx) =>
            ctx.machine
              .hook("connect", (e) => Effect.sync(() => calls.push(e.name)))
              .pipe(Effect.map((registration) => void registrations.push(registration))),
        }),
      ],
    },
  )

  it.effect("machineHooks fires a plugin's machine hooks in a plugin test", () =>
    Effect.gen(function* () {
      const hooks = yield* machineHooks(noting("one", "first", "view"))
      assert.deepStrictEqual(yield* hooks.fire("connect", event), [{ message: "first", fix: "fix one" }])
      assert.deepStrictEqual(yield* hooks.fire("connect", event, "other"), [])
      assert.deepStrictEqual(yield* hooks.fire("remove", event), [{ message: "removed by one" }])
    }).pipe(Effect.scoped),
  )
})
