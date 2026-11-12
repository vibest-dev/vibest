import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"

import { Catalog, encodeData } from "../src/event.ts"

describe("event catalog", () => {
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
})
