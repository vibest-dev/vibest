import fs from "node:fs"

import { assert, describe, it } from "@effect/vitest"
import { OPENAPI_JSON, render } from "@vibest/protocol/scripts/contract"

describe("contract", () => {
  it("openapi.json is what VibestApi generates", () => {
    assert.strictEqual(fs.readFileSync(OPENAPI_JSON, "utf8"), render(), "run pnpm --filter @vibest/protocol contract")
  })
})
