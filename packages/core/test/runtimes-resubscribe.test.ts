import { assert, it } from "@effect/vitest"
import { Bus, type BusEvent } from "@vibest/core/bus"
import { Runtimes, type Runtime } from "@vibest/core/runtimes"
import { Effect, Layer, Queue, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"

import { noHostEnv } from "./lib/harnesses.ts"

it.effect(
  "a failed runtime events stream is subscribed again and runtime.reset is published once the new subscription exists",
  () =>
    Effect.gen(function* () {
      const bus = yield* Bus
      const runtimes = yield* Runtimes
      const subscriptions = yield* Ref.make(0)
      const resets = yield* Ref.make<ReadonlyArray<number>>([])
      const seen = yield* Queue.unbounded<BusEvent>()
      yield* bus.subscribe.pipe(
        Effect.flatMap((sub) =>
          Stream.fromSubscription(sub).pipe(
            Stream.runForEach((event) =>
              event.type === "runtime.reset"
                ? Ref.get(subscriptions).pipe(
                    Effect.flatMap((count) => Ref.update(resets, (all) => [...all, count])),
                    Effect.andThen(Queue.offer(seen, event)),
                  )
                : Queue.offer(seen, event),
            ),
          ),
        ),
        Effect.forkScoped,
      )
      const events = Effect.gen(function* () {
        const attempt = yield* Ref.updateAndGet(subscriptions, (n) => n + 1)
        return attempt === 1
          ? Stream.fail("boom")
          : Stream.make({ type: "state" as const, terminal: { id: "t1" }, state: "idle" as const })
      }).pipe(Stream.unwrap)
      yield* runtimes.transform((editor) => editor.add({ id: "fake", events } as unknown as Runtime))
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      const types: Array<string> = []
      while (!types.includes("terminal.state") || !types.includes("runtime.reset")) {
        const event = yield* Queue.take(seen)
        types.push(event.type)
      }
      assert.strictEqual(yield* Ref.get(subscriptions), 2)
      assert.deepStrictEqual((yield* Ref.get(resets)).at(-1), 2)
    }).pipe(
      Effect.provide(Layer.mergeAll(Runtimes.layer.pipe(Layer.provideMerge(Bus.layer), Layer.provide(noHostEnv)))),
    ),
)
