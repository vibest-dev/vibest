import { Db } from "@vibest/core/db"
import { Harnesses } from "@vibest/core/harness"
import { turnEndFrom } from "@vibest/core/results"
import { Sessions } from "@vibest/core/sessions"
import { Clock, Effect, Predicate, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

export class GaveUp extends Schema.TaggedError<GaveUp>()("GaveUp", { helper: Schema.String }) {}

const isTestClock = (clock: Clock.Clock): clock is TestClock.TestClock => "withLive" in clock

const ioPause = Effect.sleep("10 millis")

export const yieldToIo = Clock.clockWith((clock) => (isTestClock(clock) ? clock.withLive(ioPause) : ioPause))

const UNTIL_ATTEMPTS = 2000

const poll = <A, E, R, R2>(
  f: Effect.Effect<A, E, R>,
  done: Predicate.Predicate<A>,
  step: Effect.Effect<void, never, R2>,
  attempts: number,
  helper: string,
) =>
  f.pipe(
    Effect.tap((a) => (done(a) ? Effect.void : step)),
    Effect.repeat({ until: done, times: attempts }),
    Effect.filterOrFail(done, () => new GaveUp({ helper })),
  )

export function until<A, B extends A, E, R>(
  f: Effect.Effect<A, E, R>,
  done: Predicate.Refinement<A, B>,
): Effect.Effect<B, E | GaveUp, R>
export function until<A, E, R>(f: Effect.Effect<A, E, R>, done: Predicate.Predicate<A>): Effect.Effect<A, E | GaveUp, R>
export function until<A, E, R>(f: Effect.Effect<A, E, R>, done: Predicate.Predicate<A>) {
  return poll(f, done, yieldToIo, UNTIL_ATTEMPTS, "until")
}

export const settled = Effect.gen(function* () {
  const sessions = yield* Sessions
  yield* yieldToIo
  yield* until(sessions.inMemory, (m) => m.locks === 0)
})

export const untilVirtual = <A, E, R>(f: Effect.Effect<A, E, R>, done: Predicate.Predicate<A>) =>
  poll(f, done, yieldToIo.pipe(Effect.andThen(TestClock.adjust("100 millis"))), 1000, "untilVirtual")

export const writeResult = (id: string, harness: string, payload: object, offsetMs = 1000) =>
  Effect.gen(function* () {
    const adapter = yield* (yield* Harnesses).get(harness)
    const at = (yield* Clock.currentTimeMillis) + offsetMs
    yield* (yield* Db).reportTurn(id, turnEndFrom(adapter, payload as Record<string, unknown>, at))
  })

export const eventsOf = (sessionId: string, type?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ id: number; type: string; at: number; data: string }>`SELECT id, type, at, data FROM event
      WHERE session_id = ${sessionId} ${type === undefined ? sql`` : sql`AND type = ${type}`} ORDER BY id`
    return rows.map((r) => ({ id: r.id, type: r.type, at: r.at, data: JSON.parse(r.data) as Record<string, unknown> }))
  }).pipe(Effect.orDie)
