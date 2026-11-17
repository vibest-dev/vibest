import { Effect, Exit, Scope, Stream } from "effect"
import { expect, test } from "vitest"

import type { Context } from "../src/effect/index.ts"
import { fromPromise } from "../src/promise/adapter.ts"

const registration = { dispose: Effect.void }

const host: Context = {
  options: {},
  agent: { hook: () => Effect.succeed(registration), transform: () => Effect.succeed(registration) },
  machine: { hook: () => Effect.succeed(registration) },
  runtime: { transform: () => Effect.succeed(registration) },
  harness: { transform: () => Effect.succeed(registration) },
  subscription: { report: () => Effect.void },
  event: { subscribe: () => Stream.never },
}

test("an iterator the plugin closed is not returned again when the plugin unloads", async () => {
  const returns: Array<number> = []
  const scope = Scope.makeUnsafe()

  await Effect.runPromise(
    fromPromise({
      id: "t",
      setup: async (ctx) => {
        for (let i = 0; i < 2; i++) {
          const iterator = ctx.event.subscribe()[Symbol.asyncIterator]()
          const close = iterator.return!
          returns.push(0)
          iterator.return = () => {
            returns[i]!++

            return close()
          }

          await iterator.return()
        }
      },
    })(host).pipe(Scope.provide(scope)),
  )
  await Effect.runPromise(Scope.close(scope, Exit.void))

  expect(returns).toEqual([1, 1])
})
