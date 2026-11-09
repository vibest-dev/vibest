import { assert, describe, it } from "@effect/vitest"
import { MACHINE_TIMEOUT, makeHost, Plugins } from "@vibest/core/plugins"
import { Plugin } from "@vibest/plugin"
import { machineHooks } from "@vibest/plugin/testing"
import { Duration, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"

import { testLayer, type TestOptions, type TestServices, yieldToIo } from "./fakes.ts"

const event = { name: "mb", target: "b-host", vibestd: "b-id", runtimes: [] }

const noting = (id: string, message: string) =>
  Plugin.define({
    id,
    effect: (ctx) =>
      Effect.gen(function* () {
        yield* ctx.machine.hook("connect", (e) => Effect.sync(() => e.notes.push({ message, fix: `fix ${id}` })))
        yield* ctx.machine.hook("remove", (e) => Effect.sync(() => e.notes.push({ message: `removed by ${id}` })))
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

const runtimeOwner = (id: string, kind: string) =>
  Plugin.define({
    id,
    effect: (ctx) =>
      ctx.runtime.register({
        kind,
        status: () => Effect.succeed({ status: "online" as const }),
        open: () => Effect.die(new Error("unused")),
        send: () => Effect.die(new Error("unused")),
        read: () => Effect.die(new Error("unused")),
        process: () => Effect.die(new Error("unused")),
        close: () => Effect.die(new Error("unused")),
        events: Stream.never,
      }),
  })

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices>, options: TestOptions) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer(options))))

describe("plugins: machine hooks", () => {
  test(
    "every subscriber runs after one crashes; notes are tagged in order; only reaches one plugin; unknown names fail the load",
    Effect.gen(function* () {
      const plugins = yield* Plugins
      const fired = yield* plugins.machine("connect", event)
      assert.deepStrictEqual(fired.plugins, ["one", "crashing", "two"])
      assert.deepStrictEqual(fired.notes, [
        { plugin: "one", message: "first", fix: "fix one" },
        { plugin: "crashing", message: "plugin crashing crashed: boom" },
        { plugin: "two", message: "second", fix: "fix two" },
      ])
      const only = yield* plugins.machine("connect", event, "two")
      assert.deepStrictEqual(only.plugins, ["two"])
      const removed = yield* plugins.machine("remove", event)
      assert.deepStrictEqual(
        removed.notes.map((n) => n.message),
        ["removed by one", "removed by two"],
      )
      const failed = (yield* plugins.list).find((p) => p.source === "test:unknown")
      assert.strictEqual(failed?.status, "failed")
      assert.include(failed?.error ?? "", 'unsupported hook "machine.nope"; supported: machine.connect, machine.remove')
    }),
    { plugins: [noting("one", "first"), crashing, noting("two", "second"), unknown] },
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
    "ownerOf follows ctx.runtime.register; an activation names only the plugins it started",
    Effect.gen(function* () {
      const plugins = yield* Plugins
      assert.strictEqual(yield* plugins.ownerOf("view"), "viewer")
      assert.isUndefined(yield* plugins.ownerOf("nothing"))
      const host = yield* makeHost()
      const seen: Array<ReadonlyArray<string>> = []
      const candidate = (plugin: Plugin.Plugin) => ({ source: `x:${plugin.id}`, revision: "-", options: {}, plugin })
      const follow = yield* host.service.activated.pipe(
        Stream.runForEach((ids) => Effect.sync(() => seen.push(ids))),
        Effect.forkScoped,
      )
      yield* yieldToIo
      yield* host.activate([candidate(noting("a", "x"))])
      yield* host.activate([candidate(noting("a", "x")), candidate(runtimeOwner("b", "other"))])
      yield* yieldToIo
      assert.deepStrictEqual(seen, [["a"], ["b"]])
      assert.strictEqual(yield* host.service.ownerOf("other"), "b")
      yield* host.activate([candidate(noting("a", "x"))])
      assert.isUndefined(yield* host.service.ownerOf("other"), "dropped when the plugin stops")
      yield* Fiber.interrupt(follow)
    }).pipe(Effect.scoped),
    { plugins: [runtimeOwner("viewer", "view")] },
  )

  it.effect("machineHooks fires a plugin's machine hooks in a plugin test", () =>
    Effect.gen(function* () {
      const hooks = yield* machineHooks(noting("one", "first"))
      assert.deepStrictEqual(yield* hooks.fire("connect", event), [{ message: "first", fix: "fix one" }])
      assert.deepStrictEqual(yield* hooks.fire("remove", event), [{ message: "removed by one" }])
    }).pipe(Effect.scoped),
  )
})
