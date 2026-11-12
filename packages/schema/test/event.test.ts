import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"

import { Catalog, decodeRow, encodeData, type Row } from "../src/event.ts"
import samples from "./event-rows.json" with { type: "json" }

const rows: ReadonlyArray<Row> = samples

describe("event catalog", () => {
  it.effect("session and project facts name their aggregate as their session or project", () =>
    Effect.gen(function* () {
      for (const row of rows) {
        const fact = yield* decodeRow(row)
        const kind = Catalog[fact.type].aggregate
        assert.strictEqual(fact.sessionId, kind === "session" ? row.aggregate : undefined)
        assert.strictEqual(fact.projectId, kind === "project" ? row.aggregate : undefined)
      }
    }),
  )

  it.effect("every sample row decodes and encodes back to the same bytes", () =>
    Effect.gen(function* () {
      for (const row of rows) {
        const fact = yield* decodeRow(row)
        assert.strictEqual(fact.seq, row.seq)
        assert.strictEqual(fact.aggregate, row.aggregate)
        assert.strictEqual(yield* encodeData(Catalog[fact.type], fact.data as never), row.data, `event ${row.seq}`)
      }
    }),
  )

  it.effect("encoding refuses a key the definition does not have", () =>
    Effect.gen(function* () {
      const exit = yield* encodeData(Catalog["session.renamed"], { name: "x", extra: 1 } as never).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
    }),
  )

  for (const ms of [Number.NaN, Number.POSITIVE_INFINITY])
    it.effect(`encoding refuses data whose JSON does not read back (trace ms ${ms})`, () =>
      Effect.gen(function* () {
        const exit = yield* encodeData(Catalog["process.started"], {
          harness: "pi",
          runtime: "herdr",
          routing: { decidedBy: {}, trace: [{ plugin: "p", hook: "h", outcome: "ok", ms, changes: [] }] },
        }).pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(exit))
      }),
    )

  it.effect("encoding refuses an empty string where a key must be absent or non-empty", () =>
    Effect.gen(function* () {
      const exit = yield* encodeData(Catalog["execution.started"], { typed: "" }).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
    }),
  )

  const base = rows.find((row) => row.type === "session.renamed")!
  const refused: ReadonlyArray<[string, Row]> = [
    ["a type outside the catalog", { ...base, type: "session.purged" }],
    ["a key the definition does not have", { ...base, data: '{"name":"x","extra":1}' }],
    ["data that is not JSON", { ...base, data: "{" }],
  ]
  for (const [what, row] of refused)
    it.effect(`decoding refuses ${what} and names the event`, () =>
      Effect.gen(function* () {
        const error = yield* decodeRow(row).pipe(Effect.flip)
        assert.strictEqual(error._tag, "UnknownFact")
        assert.strictEqual(error.seq, row.seq)
        assert.include(error.message, `event ${row.aggregate} ${row.seq}`)
      }),
    )
})
