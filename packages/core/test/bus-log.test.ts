import { assert, describe, it } from "@effect/vitest"
import { Bus, RuntimeReset, TerminalExited } from "@vibest/core/bus"
import { installLedger } from "@vibest/core/database/migration"
import * as Projectors from "@vibest/core/database/projectors"
import { Catalog } from "@vibest/schema/event"
import { Effect, Fiber, Layer, PubSub, Stream } from "effect"
import { SqlClient } from "effect/sql"

import { memorySqlite } from "./platform/bun.ts"

const P = "11111111-1111-4111-8111-111111111111"
const MAIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SUB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const memory = () => Layer.fresh(Projectors.replay.pipe(Layer.provideMerge(memorySqlite)))

const ledger = Effect.gen(function* () {
  yield* installLedger
  const bus = yield* Bus.Service
  const subscription = yield* bus.subscribe()
  const published = PubSub.takeUpTo(subscription, Number.MAX_SAFE_INTEGER)
  const sql = yield* SqlClient.SqlClient

  return { bus, published, sql }
})

describe("log", () => {
  const project = { projectId: P, data: { directory: "/w/app", repositories: [] } }

  const session = (sessionId: string) => ({
    sessionId,
    data: { project: P, agent: "main", name: "n", directory: "" },
  })

  const seqs = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

  it.effect("a session read pages past 1000 facts in seq order and a log read keeps each seq rising", () =>
    Effect.gen(function* () {
      const { bus } = yield* ledger
      yield* bus.transaction(
        Effect.gen(function* () {
          yield* bus.publish(Catalog["project.created"], project)
          yield* bus.publish(Catalog["session.created"], session(MAIN))
          yield* bus.publish(Catalog["session.created"], session(SUB))

          for (let i = 0; i < 1100; i++)
            yield* bus.publish(Catalog["session.renamed"], {
              sessionId: i < 1050 ? MAIN : SUB,
              data: { name: `n${i}` },
            })
        }),
      )

      const read = (input: { readonly aggregate?: string }) =>
        Stream.runCollect(bus.log({ ...input, follow: false })).pipe(Effect.map((rows) => Array.from(rows)))

      const own = yield* read({ aggregate: MAIN })
      assert.deepStrictEqual(
        own.map((r) => r.seq),
        seqs(1051),
      )
      const all = yield* read({})
      assert.strictEqual(all.length, 1103)
      assert.deepStrictEqual(Object.keys(all[0]!).sort(), ["aggregate", "at", "data", "seq", "type"])

      for (const aggregate of [P, MAIN, SUB]) {
        const mine = all.filter((r) => r.aggregate === aggregate)
        assert.deepStrictEqual(
          mine.map((r) => r.seq),
          seqs(mine.length),
        )
      }
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a follow started before two commits yields each fact once and in order", () =>
    Effect.gen(function* () {
      const { bus } = yield* ledger

      const fiber = yield* Stream.runCollect(bus.log({ aggregate: MAIN, follow: true }).pipe(Stream.take(2))).pipe(
        Effect.forkChild,
      )

      yield* bus.transaction(
        Effect.gen(function* () {
          yield* bus.publish(Catalog["project.created"], project)
          yield* bus.publish(Catalog["session.created"], session(MAIN))
        }),
      )
      yield* bus.transaction(bus.publish(Catalog["session.renamed"], { sessionId: MAIN, data: { name: "x" } }))
      const rows = Array.from(yield* Fiber.join(fiber))
      assert.deepStrictEqual(
        rows.map((r) => [r.seq, r.type]),
        [
          [1, "session.created"],
          [2, "session.renamed"],
        ],
      )
    }).pipe(Effect.provide(memory())),
  )

  it.effect("a finite read stops at the watermark taken when it starts and a resume starts after a seq", () =>
    Effect.gen(function* () {
      const { bus } = yield* ledger
      yield* bus.transaction(
        Effect.gen(function* () {
          yield* bus.publish(Catalog["project.created"], project)
          yield* bus.publish(Catalog["session.created"], session(MAIN))
        }),
      )

      const rename = (name: string) =>
        bus.transaction(bus.publish(Catalog["session.renamed"], { sessionId: MAIN, data: { name } }))

      const read = (input: { readonly aggregate?: string }) =>
        Stream.runCollect(bus.log({ ...input, follow: false }).pipe(Stream.tap(() => rename("late")))).pipe(
          Effect.map((rows) => Array.from(rows)),
        )

      const own = yield* read({ aggregate: MAIN })
      assert.deepStrictEqual(
        own.map((r) => r.seq),
        [1],
      )
      const whole = yield* read({})
      assert.strictEqual(whole.length, 3)
      yield* rename("x")
      const resumed = yield* Stream.runCollect(bus.log({ aggregate: MAIN, after: 1, follow: false }))
      assert.deepStrictEqual(
        Array.from(resumed).map((r) => r.seq),
        seqs(6).slice(1),
      )
    }).pipe(Effect.provide(memory())),
  )
})

const exited = { type: "terminal.exited", runtime: "r", terminal: { machine: "local", id: "t" } } as const
const released = { type: "runtime.reset", runtime: "r", machine: "local" } as const

describe("subscribe", () => {
  it.effect("a subscriber of one type retains no other type, and several types keep publish order", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const one = yield* bus.subscribe([TerminalExited])
      const both = yield* bus.subscribe([TerminalExited, RuntimeReset])
      const all = yield* bus.subscribe()
      yield* bus.observe(released)
      yield* bus.observe(released)
      yield* bus.observe(exited)
      yield* bus.observe(released)
      assert.deepStrictEqual(yield* PubSub.takeAll(one), [exited])
      assert.deepStrictEqual(yield* PubSub.takeAll(both), [released, released, exited, released])
      assert.strictEqual((yield* PubSub.takeAll(all)).length, 4)
    }).pipe(Effect.provide(memory()), Effect.scoped),
  )
})
