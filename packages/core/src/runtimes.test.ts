import { assert, describe, it } from "@effect/vitest"
import type { Runtime } from "@vibest/plugin"
import { Cause, Deferred, Effect, Exit, Layer, Logger, PubSub, Stream } from "effect"

import { Bus } from "./bus.ts"
import { HostEnv, NoRuntime, Runtimes } from "./runtimes.ts"

const hostEnv = Layer.succeed(HostEnv, { drop: () => {} })

const runtime = (events: Stream.Stream<Runtime.RuntimeEvent, Error>) =>
  ({
    id: "fake",
    events,
    status: () => Effect.succeed({ status: "online" as const }),
  }) as unknown as Runtime.RuntimeDefinition

const logged = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const logs: Array<unknown> = []
  return effect.pipe(
    Effect.provide(Runtimes.layer),
    Effect.provide(Bus.layer),
    Effect.provide(hostEnv),
    Effect.provide(Logger.layer([Logger.make((entry) => void logs.push(entry.message))])),
    Effect.scoped,
    Effect.map((value) => ({ value, logs })),
  )
}

describe("runtime events", () => {
  it.effect("a runtime events failure is logged with its cause and publishes live.reset", () =>
    logged(
      Effect.gen(function* () {
        const bus = yield* Bus
        const sub = yield* bus.subscribe
        const open = yield* Deferred.make<void>()
        const runtimes = yield* Runtimes
        yield* runtimes.transform((editor) =>
          editor.add(
            runtime(Stream.unwrap(Deferred.await(open).pipe(Effect.as(Stream.fail(new Error("socket closed")))))),
          ),
        )
        assert.deepStrictEqual(yield* PubSub.take(sub), { type: "live.reset", runtime: "fake", machine: "local" })
        yield* Effect.yieldNow
        yield* Deferred.succeed(open, undefined)
        assert.deepStrictEqual(yield* PubSub.take(sub), { type: "live.reset", runtime: "fake", machine: "local" })
        assert.deepStrictEqual(yield* PubSub.takeUpTo(sub, 10), [])
      }),
    ).pipe(
      Effect.map(({ logs }) => {
        assert.include(JSON.stringify(logs), "socket closed")
        assert.include(JSON.stringify(logs), "fake")
      }),
    ),
  )

  it.effect("replacing a runtime interrupts its events stream without an error log or an extra reset", () =>
    logged(
      Effect.gen(function* () {
        const bus = yield* Bus
        const sub = yield* bus.subscribe
        const runtimes = yield* Runtimes
        yield* runtimes.transform((editor) => editor.add(runtime(Stream.never)))
        assert.deepStrictEqual(yield* PubSub.take(sub), { type: "live.reset", runtime: "fake", machine: "local" })
        yield* runtimes.transform((editor) => editor.add(runtime(Stream.never.pipe(Stream.ensuring(Effect.void)))))
        assert.deepStrictEqual(yield* PubSub.takeUpTo(sub, 10), [
          { type: "live.reset", runtime: "fake", machine: "local" },
        ])
      }),
    ).pipe(
      Effect.map(({ logs }) => {
        assert.deepStrictEqual(logs, [])
      }),
    ),
  )

  it.effect("online turns a defect in status into NoRuntime", () =>
    Effect.gen(function* () {
      const runtimes = yield* Runtimes
      const exit = yield* Effect.exit(
        runtimes.online(
          { ...runtime(Stream.never), status: () => Effect.die("status exploded") } as Runtime.RuntimeDefinition,
          { id: "local" },
        ),
      )
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      assert.ok(error instanceof NoRuntime)
      assert.include(error.message, "could not be read")
      assert.include(error.message, "status exploded")
      assert.include(error.message, "could not be read")
      assert.include(error.message, "status exploded")
    }).pipe(Effect.provide(Runtimes.layer), Effect.provide(Bus.layer), Effect.provide(hostEnv), Effect.scoped),
  )

  it.effect("online leaves an interrupt from status alone", () =>
    Effect.gen(function* () {
      const runtimes = yield* Runtimes
      const exit = yield* Effect.exit(
        runtimes.online({ ...runtime(Stream.never), status: () => Effect.interrupt } as Runtime.RuntimeDefinition, {
          id: "local",
        }),
      )
      assert.strictEqual(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), true)
    }).pipe(Effect.provide(Runtimes.layer), Effect.provide(Bus.layer), Effect.provide(hostEnv), Effect.scoped),
  )
})
