import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"

import { Catalog, decodeRow, encodeData, type FactType, type Row } from "../src/event.ts"
import samples from "./event-rows.json" with { type: "json" }

const rows: ReadonlyArray<Row> = samples

const topLevelKeys = (type: FactType) => {
  const fields: Schema.Struct.Fields = Catalog[type].data.fields
  return Object.entries(fields).map(([key, schema]) => ({ key, optional: schema.ast.context?.isOptional === true }))
}

describe("event catalog", () => {
  it.effect("every sample row decodes and encodes back to the same bytes", () =>
    Effect.gen(function* () {
      for (const row of rows) {
        const fact = yield* decodeRow(row)
        assert.strictEqual(fact.seq, row.seq)
        assert.strictEqual(yield* encodeData(Catalog[fact.type], fact.data as never), row.data, `event ${row.seq}`)
      }
    }),
  )

  it("the samples cover every type, and every optional key both present and absent", () => {
    for (const type of Object.keys(Catalog) as Array<FactType>) {
      const data = rows.filter((row) => row.type === type).map((row) => JSON.parse(row.data) as object)
      assert.isAbove(data.length, 0, `${type} has no sample`)
      for (const { key, optional } of topLevelKeys(type)) {
        const present = data.filter((d) => Object.hasOwn(d, key)).length
        assert.isAbove(present, 0, `${type}.${key} is never present`)
        if (optional) assert.isBelow(present, data.length, `${type}.${key} is never absent`)
        else assert.strictEqual(present, data.length, `${type}.${key} is required`)
      }
    }
  })

  it("the samples cover every optional key of a routing trace entry and change", () => {
    const traces = rows
      .filter((row) => row.type === "process.started")
      .flatMap(
        (row) => (JSON.parse(row.data) as { routing?: { trace: Array<Record<string, unknown>> } }).routing?.trace ?? [],
      )
    const changes = traces.flatMap((entry) => entry["changes"] as Array<Record<string, unknown>>)
    for (const key of ["reason", "error"])
      assert.isTrue(
        traces.some((entry) => Object.hasOwn(entry, key)),
        key,
      )
    for (const key of ["from", "to", "overwrote"])
      assert.isTrue(
        changes.some((change) => Object.hasOwn(change, key)),
        key,
      )
  })

  it("catalog keys are the type names of their definitions", () => {
    for (const [type, definition] of Object.entries(Catalog)) assert.strictEqual(definition.type, type)
  })

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
      const exit = yield* encodeData(Catalog["turn.started"], { typed: "" }).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
    }),
  )

  const base = rows.find((row) => row.type === "session.renamed")!
  const refused: ReadonlyArray<[string, Row]> = [
    ["a type outside the catalog", { ...base, type: "session.purged" }],
    ["a key the definition does not have", { ...base, data: '{"name":"x","extra":1}' }],
    ["data that is not JSON", { ...base, data: "{" }],
    ["a session fact without a session", { ...base, session_id: null }],
    [
      "a machine fact with a project",
      { ...rows.find((row) => row.type === "machine.added")!, project_id: base.project_id },
    ],
    [
      "a project fact with a session",
      { ...rows.find((row) => row.type === "project.moved")!, session_id: base.session_id },
    ],
  ]
  for (const [what, row] of refused)
    it.effect(`decoding refuses ${what} and names the event`, () =>
      Effect.gen(function* () {
        const error = yield* decodeRow(row).pipe(Effect.flip)
        assert.strictEqual(error._tag, "UnknownFact")
        assert.strictEqual(error.seq, row.seq)
        assert.include(error.message, `event ${row.seq}`)
      }),
    )
})
