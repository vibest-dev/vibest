import { assert, describe, it } from "@effect/vitest"
import { awaitEvent, Bus, type EngineEvent } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { Runtimes } from "@vibest/core/runtimes"
import type { Runtime } from "@vibest/plugin"
import { Cause, Duration, Effect, Exit, Fiber, Layer, Option, PubSub } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { projectOf } from "./fakes.ts"

const sqlite = Platform.sqlite(":memory:")
const dbLayer = Layer.merge(Db.layer.pipe(Layer.provideMerge(sqlite)), Bus.layer).pipe(Layer.provide(Bus.layer))

const session = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  agent: "general",
  name: "n",
  harnessId: "pi" as const,
  provider: null,
  model: null,
  harnessSessionId: null,
  runtime: "bench",
  address: { machine: "bench", id: "b0" },
  status: "unknown" as const,
  startedAt: null,
  exitedAt: null,
  turnState: "none" as const,
  turnPromptedAt: 0,
  metadata: {},
  createdAt: 1,
  lastActive: 1,
}

const isStored = (event: EngineEvent): event is EngineEvent & { id: number; data: Readonly<Record<string, unknown>> } =>
  "id" in event

describe("bus", () => {
  it.effect("a commit publishes in id order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Db
        const bus = yield* Bus
        yield* db.insertSession(session, yield* projectOf("r"))
        const sub = yield* bus.subscribe
        const ids = yield* db.tx(
          Effect.gen(function* () {
            const first = yield* db.append({
              sessionId: session.id,
              type: "process.conversation",
              data: { n: 1 },
            })
            const second = yield* db.append({
              sessionId: session.id,
              type: "process.conversation",
              data: { n: 2 },
            })
            assert.deepStrictEqual(yield* PubSub.takeUpTo(sub, 10), [])
            return [first, second]
          }),
        )
        const published = yield* PubSub.takeUpTo(sub, 10)
        assert.deepStrictEqual(
          published.map((event) => (isStored(event) ? event.id : 0)),
          ids,
        )
        assert.deepStrictEqual(
          published.map((event) => (isStored(event) ? event.data.n : 0)),
          [1, 2],
        )
      }),
    ).pipe(Effect.provide(dbLayer)),
  )

  it.effect("a rollback publishes nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Db
        const bus = yield* Bus
        const sql = yield* SqlClient.SqlClient
        yield* db.insertSession(session, yield* projectOf("r"))
        const sub = yield* bus.subscribe
        const exit = yield* db
          .tx(
            Effect.gen(function* () {
              yield* db.append({ sessionId: session.id, type: "process.conversation", data: { n: "no" } })
              return yield* Effect.fail("rollback")
            }),
          )
          .pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(exit))
        assert.deepStrictEqual(yield* PubSub.takeUpTo(sub, 10), [])
        const left = yield* sql<{ n: number }>`SELECT count(*) AS n FROM event WHERE json_extract(data, '$.n') = 'no'`
        assert.strictEqual(left[0]?.n, 0)
      }),
    ).pipe(Effect.provide(dbLayer)),
  )

  it.effect("a nested tx publishes once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* Db
        const bus = yield* Bus
        yield* db.insertSession(session, yield* projectOf("r"))
        const sub = yield* bus.subscribe
        yield* db.tx(
          Effect.gen(function* () {
            yield* db.append({ sessionId: session.id, type: "process.conversation", data: { n: 1 } })
            yield* db.tx(
              db.append({ sessionId: session.id, type: "process.conversation", data: { n: 2 } }).pipe(Effect.asVoid),
            )
            assert.deepStrictEqual(yield* PubSub.takeUpTo(sub, 10), [])
          }),
        )
        assert.strictEqual((yield* PubSub.takeUpTo(sub, 10)).length, 2)
      }),
    ).pipe(Effect.provide(dbLayer)),
  )

  it.effect("append outside tx dies", () =>
    Effect.gen(function* () {
      const db = yield* Db
      const exit = yield* db.append({ sessionId: session.id, type: "process.conversation", data: {} }).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
    }).pipe(Effect.provide(dbLayer)),
  )

  it.effect("register publishes live.reset", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bus = yield* Bus
        const runtimes = yield* Runtimes
        const sub = yield* bus.subscribe
        yield* runtimes.register({ kind: "bench" } as Runtime.Runtime).pipe(Effect.scoped)
        assert.deepStrictEqual(yield* PubSub.takeUpTo(sub, 5), [
          { type: "live.reset", runtime: "bench", machine: "local" },
        ])
      }),
    ).pipe(Effect.provide(Runtimes.layer), Effect.provide(Bus.layer)),
  )

  it.effect("a release publishes live.drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bus = yield* Bus
        const drain = yield* Drain
        const sub = yield* bus.subscribe
        const release = drain.track("one")
        yield* release
        yield* release
        assert.deepStrictEqual(yield* PubSub.takeUpTo(sub, 5), [{ type: "live.drain" }])
      }),
    ).pipe(Effect.provide(Drain.layer), Effect.provide(Bus.layer)),
  )

  it.effect("an event between subscribe and look resolves", () =>
    Effect.gen(function* () {
      const bus = yield* Bus
      const value = yield* awaitEvent(
        Effect.gen(function* () {
          yield* bus.observe({ type: "live.drain" })
          return Option.none()
        }),
        (event) => Effect.succeed(event.type === "live.drain" ? Option.some("seen") : Option.none()),
        Duration.seconds(10),
        Effect.succeed("deadline"),
      )
      assert.strictEqual(value, "seen")
    }).pipe(Effect.provide(Bus.layer)),
  )

  it.effect("the deadline runs the final look once", () =>
    Effect.gen(function* () {
      let looks = 0
      const fiber = yield* awaitEvent(
        Effect.succeed(Option.none<string>()),
        () => Effect.succeed(Option.none<string>()),
        Duration.seconds(5),
        Effect.sync(() => {
          looks++
          return "final"
        }),
      ).pipe(Effect.forkChild)
      yield* TestClock.adjust("5 seconds")
      assert.strictEqual(yield* Fiber.join(fiber), "final")
      assert.strictEqual(looks, 1)
      yield* TestClock.adjust("5 seconds")
      assert.strictEqual(looks, 1)
    }).pipe(Effect.provide(Bus.layer)),
  )
})
