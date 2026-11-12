import { assert, describe, it } from "@effect/vitest"
import { reconnectSchedule } from "@vibest/plugin"
import { Duration, Effect, Schedule } from "effect"

describe("reconnectSchedule", () => {
  it.effect("starts at first, doubles, caps at max, and a new step starts over", () =>
    Effect.gen(function* () {
      const schedule = reconnectSchedule({ first: "500 millis", max: "3 seconds" })
      const step = yield* Schedule.toStep(schedule)
      const delays: Array<number> = []
      for (let i = 0; i < 5; i++) {
        const [, delay] = yield* Effect.orDie(step(0, undefined))
        delays.push(Duration.toMillis(delay))
      }
      assert.deepStrictEqual(delays, [500, 1000, 2000, 3000, 3000])
      const again = yield* Schedule.toStep(schedule)
      const [, first] = yield* Effect.orDie(again(0, undefined))
      assert.strictEqual(Duration.toMillis(first), 500)
    }),
  )
})
