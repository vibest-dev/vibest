import fs from "node:fs"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { USED_METHODS } from "effect-herdr-core-sdk"

const src = path.join(import.meta.dirname, "..", "src")
const code = fs
  .readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts"))
  .map((f) => fs.readFileSync(path.join(src, f), "utf8"))
  .join("\n")

const called = [
  ...new Set([
    ...[...code.matchAll(/\.call\(\s*"([a-z_.]+)"/g)].map((m) => m[1]),
    ...(/\.subscribe\(/.test(code) ? ["events.subscribe"] : []),
  ]),
].sort()

describe("USED_METHODS", () => {
  it("lists exactly the hc methods runtime-herdr-core calls", () => {
    assert.isAbove(called.length, 0)
    assert.deepStrictEqual([...USED_METHODS].sort(), called)
  })
})
