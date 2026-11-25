import { assert, describe, it } from "@effect/vitest"
import { Bus, TerminalExited } from "@vibest/core/bus"
import * as Reactor from "@vibest/core/reactor"
import { memoryBus } from "@vibest/testkit/bun"
import { Effect, Layer } from "effect"

describe("Reactor", () => {
  it.live("a handler that throws while being built does not end the subscription", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const reactor = yield* Reactor.make
      let calls = 0
      const seen: Array<number> = []
      yield* reactor.on([TerminalExited], () => {
        calls += 1

        if (calls === 1) throw new Error("built badly")

        return Effect.sync(() => void seen.push(calls))
      })
      yield* Effect.yieldNow
      yield* bus.publish(TerminalExited, { runtime: "r", terminal: { id: "t" }, processes: [] })
      yield* bus.publish(TerminalExited, { runtime: "r", terminal: { id: "t" }, processes: [] })
      yield* Effect.sleep("20 millis")
      assert.deepStrictEqual(seen, [2])
    }).pipe(Effect.provide(Layer.fresh(memoryBus)), Effect.scoped),
  )
})
