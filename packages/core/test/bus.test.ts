import { assert, describe, it } from "@effect/vitest"
import { Bus, RuntimeReset, TerminalExited } from "@vibest/core/bus"
import { Effect, PubSub } from "effect"

const exited = { type: "terminal.exited", runtime: "r", terminal: { machine: "local", id: "t" } } as const
const released = { type: "runtime.reset", runtime: "r", machine: "local" } as const

describe("Bus.subscribe", () => {
  it.effect("a subscriber of one type retains no other type, and several types keep publish order", () =>
    Effect.gen(function* () {
      const bus = yield* Bus
      const one = yield* bus.subscribe([TerminalExited])
      const both = yield* bus.subscribe([TerminalExited, RuntimeReset])
      const all = yield* bus.subscribe()
      yield* bus.observe(released)
      yield* bus.observe(released)
      yield* bus.observe(exited)
      yield* bus.observe(released)
      assert.deepStrictEqual(yield* PubSub.takeAll(one), [exited])
      assert.deepStrictEqual(yield* PubSub.takeAll(both), [released, released, exited, released])
      assert.strictEqual((yield* PubSub.takeAll(all)).length, 4)
    }).pipe(Effect.provide(Bus.layer), Effect.scoped),
  )
})
