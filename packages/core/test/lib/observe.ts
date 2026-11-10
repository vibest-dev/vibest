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
    const rows = yield* sql<{ id: number; type: string; at: number; data: string }>`SELECT id, type, at, data FROM event
      WHERE session_id = ${sessionId} ${type === undefined ? sql`` : sql`AND type = ${type}`} ORDER BY id`
    return rows.map((r) => ({ id: r.id, type: r.type, at: r.at, data: JSON.parse(r.data) as Record<string, unknown> }))
  }).pipe(Effect.orDie)

export const resultText = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ text: string | null }>`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM event te WHERE te.type = 'turn.end' AND json_extract(te.data, '$.report') = r.id)
      THEN NULL ELSE json_extract(r.data, '$.text') END AS text
      FROM event r WHERE r.session_id = ${id} AND r.type = 'turn.reported' ORDER BY r.id DESC LIMIT 1`.pipe(
      Effect.orDie,
    )
    return row?.text ?? ""
  })

export const TURNS = `(SELECT t.id, t.session_id, t.at AS started_at, te.at AS ended_at, te.id AS end_id,
    (SELECT max(e.inbox_id) FROM event e WHERE e.turn_id = t.id AND e.type = 'inbox.status'
      AND json_extract(e.data, '$.to') = 'delivered') AS inbox_id,
    coalesce(json_extract(t.data, '$.typed'), (SELECT group_concat(c, char(10) || char(10)) FROM (SELECT i.content AS c
      FROM inbox i WHERE i.id IN (SELECT e.inbox_id FROM event e WHERE e.turn_id = t.id AND e.type = 'inbox.status'
        AND json_extract(e.data, '$.to') = 'delivered') ORDER BY i.id)), '') AS input,
    CASE WHEN te.id IS NULL THEN 'working' ELSE json_extract(te.data, '$.status') END AS status,
    (SELECT r.content FROM inbox r WHERE r.result_event_id = te.id) AS output
  FROM event t LEFT JOIN event te ON te.turn_id = t.id AND te.type = 'turn.end' WHERE t.type = 'turn.start')`

export const processEnds = (sessionId: string) =>
  eventsOf(sessionId, "process.end").pipe(Effect.map((rows) => rows.map((r) => r.data.reason)))

export const systemPromptFile = (id: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(yield* systemPromptRoot, id, "system-prompt.md")
  })
