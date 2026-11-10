import { Db } from "@vibest/core/db"
import { Harnesses } from "@vibest/core/harness"
import { turnEndFrom } from "@vibest/core/results"
import { Sessions } from "@vibest/core/sessions"
import { systemPromptRoot } from "@vibest/core/system-prompt"
import { Clock, Effect, Path, Predicate, Schema } from "effect"
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
    const rows = yield* sql<{ seq: number; type: string; at: number; data: string }>`SELECT seq, type, at, data
      FROM event WHERE session_id = ${sessionId} ${type === undefined ? sql`` : sql`AND type = ${type}`} ORDER BY seq`
    return rows.map((r) => ({ id: r.seq, type: r.type, at: r.at, data: JSON.parse(r.data) as Record<string, unknown> }))
  }).pipe(Effect.orDie)

export const resultText = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ data: string; consumed: number }>`SELECT r.data,
        EXISTS (SELECT 1 FROM turn t WHERE t.report_seq = r.seq) AS consumed
      FROM event r WHERE r.session_id = ${id} AND r.type = 'turn.reported' ORDER BY r.seq DESC LIMIT 1`.pipe(
      Effect.orDie,
    )
    return row === undefined || row.consumed ? "" : String((JSON.parse(row.data) as { text?: unknown }).text ?? "")
  })

export const answerOf = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ answer: string | null }>`SELECT answer FROM turn
      WHERE session_id = ${id} AND status IS NOT NULL ORDER BY id DESC LIMIT 1`.pipe(Effect.orDie)
    return row?.answer ?? undefined
  })

export const sentBy = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ id: number }>`SELECT id FROM inbox WHERE sender_session_id = ${id} ORDER BY id`.pipe(
      Effect.map((rows) => rows.map((r) => r.id)),
      Effect.orDie,
    )
  })

export const lastSentBy = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ id: number; kind: string; status: string; content: string }>`SELECT id, kind, status,
        content FROM inbox WHERE sender_session_id = ${id} ORDER BY id DESC LIMIT 1`.pipe(Effect.orDie)
    return row
  })

export const TURNS = `(SELECT t.id, t.session_id, t.started_at, t.ended_at,
    (SELECT max(i.id) FROM inbox i WHERE i.turn_id = t.id) AS inbox_id,
    coalesce(t.typed, (SELECT group_concat(c, char(10) || char(10)) FROM (SELECT i.content AS c
      FROM inbox i WHERE i.turn_id = t.id ORDER BY i.id)), '') AS input,
    coalesce(t.status, 'working') AS status,
    t.answer AS output
  FROM turn t)`

export const processEnds = (sessionId: string) =>
  eventsOf(sessionId, "process.ended").pipe(
    Effect.map((rows) => rows.map((r) => r.data.reason).filter((reason) => reason !== "superseded")),
  )

export const systemPromptFile = (id: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(yield* systemPromptRoot, id, "system-prompt.md")
  })
