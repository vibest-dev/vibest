import { assert, describe, it } from "@effect/vitest"
import { Bus, type BusEvent } from "@vibest/core/bus"
import { Runtimes, type Runtime } from "@vibest/core/runtimes"
import { Runtime as RuntimeApi } from "@vibest/plugin"
import { Effect, Layer, PubSub, Queue, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"

import { noHostEnv } from "./lib/harnesses.ts"

const layer = Runtimes.layer.pipe(Layer.provideMerge(Bus.layer), Layer.provide(noHostEnv))

const follow = (events: Stream.Stream<RuntimeApi.RuntimeEvent>) =>
  Effect.gen(function* () {
    const bus = yield* Bus
    const runtimes = yield* Runtimes
    const seen = yield* Queue.unbounded<BusEvent>()
    yield* bus.subscribe.pipe(
      Effect.flatMap((subscription) =>
        Stream.fromSubscription(subscription).pipe(Stream.runForEach((event) => Queue.offer(seen, event))),
      ),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    yield* runtimes.transform((editor) => editor.add({ id: "fake", events } as unknown as Runtime))
    return seen
  })

describe("a runtime's events stream", () => {
  it.effect("publishes runtime.reset only once the subscription is acquired, however late", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<RuntimeApi.RuntimeEvent>()
      const acquired = yield* Ref.make(false)
      const events = Effect.sleep("5 seconds").pipe(
        Effect.andThen(Ref.set(acquired, true)),
        Effect.as(RuntimeApi.eventsFrom(pubsub)),
        Stream.unwrap,
      )
      const seen = yield* follow(events)
      yield* TestClock.adjust("4 seconds")
      assert.strictEqual((yield* Queue.clear(seen)).length, 0)
      yield* TestClock.adjust("1 second")
      assert.strictEqual((yield* Queue.take(seen)).type, "runtime.reset")
      assert.isTrue(yield* Ref.get(acquired))
      yield* PubSub.publish(pubsub, { type: "state", terminal: { id: "t1" }, state: "idle" })
      assert.strictEqual((yield* Queue.take(seen)).type, "terminal.state")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("after output a failure waits the first delay again, and a failure without output waits longer", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const events = Effect.gen(function* () {
        const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
        return attempt === 2
          ? Stream.die("closed")
          : Stream.succeed<RuntimeApi.RuntimeEvent>({ type: "reset" }).pipe(Stream.concat(Stream.die("closed")))
      }).pipe(Stream.unwrap)
      yield* follow(events)
      const count = Ref.get(attempts)
      yield* Effect.yieldNow
      assert.strictEqual(yield* count, 1)
      yield* TestClock.adjust("999 millis")
      assert.strictEqual(yield* count, 1)
      yield* TestClock.adjust("1 millis")
      assert.strictEqual(yield* count, 2)
      yield* TestClock.adjust("1999 millis")
      assert.strictEqual(yield* count, 2)
      yield* TestClock.adjust("1 millis")
      assert.strictEqual(yield* count, 3)
      yield* TestClock.adjust("999 millis")
      assert.strictEqual(yield* count, 3)
      yield* TestClock.adjust("1 millis")
      assert.strictEqual(yield* count, 4)
    }).pipe(Effect.provide(layer)),
  )
})
