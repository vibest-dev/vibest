import { Effect, Scope, Stream } from "effect"
import { expect, test, vi } from "vitest"

import type { Context } from "../src/index.ts"
import { fromPromise } from "../src/promise.ts"

const returns: Array<number> = []

vi.mock("effect", async (importOriginal) => {
  const effect = await importOriginal<typeof import("effect")>()
  let count = 0
  return {
    ...effect,
    Stream: {
      ...effect.Stream,
      toAsyncIterableWith: (stream: never, context: never) => ({
        [Symbol.asyncIterator]: () => {
          const id = count++
          const iterator = effect.Stream.toAsyncIterableWith(stream, context)[Symbol.asyncIterator]()
          return {
            next: () => iterator.next(),
            return: () => {
              returns.push(id)
              return iterator.return?.() ?? Promise.resolve({ done: true, value: undefined })
            },
          }
        },
      }),
    },
  }
})

test("an iterator the plugin closed is not closed again when the plugin unloads", async () => {
  const host = { options: {}, event: { subscribe: () => Stream.make(1, 2, 3) } } as unknown as Context
  const scope = Scope.makeUnsafe()
  await Effect.runPromise(
    fromPromise({
      id: "t",
      setup: async (ctx) => {
        for (let i = 0; i < 2; i++) for await (const _ of ctx.event.subscribe()) break
      },
    })(host).pipe(Scope.provide(scope)),
  )
  expect(returns).toEqual([0, 1])
  await Effect.runPromise(Scope.close(scope, { _tag: "Success", value: undefined } as never))
  expect(returns).toEqual([0, 1])
})
