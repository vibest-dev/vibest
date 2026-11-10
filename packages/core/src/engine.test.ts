import { assert, describe, it } from "@effect/vitest"
import { Effect, Logger } from "effect"

import { logFailure } from "./engine.ts"

describe("logFailure", () => {
  it.effect("logs a failure with its cause and leaves an interrupt alone", () => {
    const logs: Array<unknown> = []
    return Effect.gen(function* () {
      yield* logFailure("work")(Effect.fail(new Error("boom")))
      yield* logFailure("work")(Effect.interrupt)
      assert.strictEqual(logs.length, 1)
      assert.include(JSON.stringify(logs), "boom")
    }).pipe(Effect.provide(Logger.layer([Logger.make((entry) => void logs.push(entry.message))])))
  })
})
