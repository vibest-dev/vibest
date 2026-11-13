import { assert, it } from "@effect/vitest"
import { Bus, type BusEvent } from "@vibest/core/bus"
import { Runtimes, type Runtime } from "@vibest/core/runtimes"
import { Effect, Layer, Queue, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"

import { noHostEnv } from "./lib/harnesses.ts"

it.effect("a failed runtime events stream is subscribed again and a runtime.reset follows the resubscription", () =>
  Effect.gen(function* () {
    const bus = yield* Bus
    const runtimes = yield* Runtimes
    const subscriptions = yield* Ref.make(0)
    const seen = yield* Queue.unbounded<BusEvent>()
    yield* bus.subscribe.pipe(
      Effect.flatMap((sub) =>
        Stream.fromSubscription(sub).pipe(Stream.runForEach((event) => Queue.offer(seen, event))),
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
    while (!types.includes("terminal.state")) {
      const event = yield* Queue.take(seen)
      types.push(event.type)
    }
    assert.strictEqual(yield* Ref.get(subscriptions), 2)
    assert.deepStrictEqual(types.slice(-2), ["runtime.reset", "terminal.state"])
  }).pipe(Effect.provide(Layer.mergeAll(Runtimes.layer.pipe(Layer.provideMerge(Bus.layer), Layer.provide(noHostEnv))))),
)
