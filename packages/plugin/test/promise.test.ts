import { Effect, Scope, Stream } from "effect"
import { expect, test, vi } from "vitest"

import type { Context } from "../src/effect/index.ts"

test("an iterator the plugin closed is not returned again when the plugin unloads", async () => {
  vi.resetModules()
  vi.doMock("effect", async (importOriginal) => {
    const effect = await importOriginal<typeof import("effect")>()
    const toAsyncIterableWith = vi.fn((stream: never, context: never) => {
      const source = effect.Stream.toAsyncIterableWith(stream, context)[Symbol.asyncIterator]()
      const iterator = { next: () => source.next(), return: vi.fn(() => source.return!()) }
      return { [Symbol.asyncIterator]: () => iterator }
    })
    return { ...effect, Stream: { ...effect.Stream, toAsyncIterableWith } }
  })
  try {
    const mocked = await import("effect")
    const { fromPromise } = await import("../src/promise/adapter.ts")
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
    await Effect.runPromise(Scope.close(scope, { _tag: "Success", value: undefined } as never))
    const iterators = vi
      .mocked(mocked.Stream.toAsyncIterableWith)
      .mock.results.map(
        (r) => (r.value as AsyncIterable<unknown>)[Symbol.asyncIterator]() as { return: ReturnType<typeof vi.fn> },
      )
    expect(iterators.map((i) => i.return.mock.calls.length)).toEqual([1, 1])
  } finally {
    vi.doUnmock("effect")
    vi.resetModules()
  }
})
