import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { consistency, parseFeatureMap } from "../src/feature-map.ts"

const table = (...rows: ReadonlyArray<string>) =>
  ["## Area", "", "| ID | Capability | Method | Pass when |", "| --- | --- | --- | --- |", ...rows, ""].join("\n")

describe("feature map", () => {
  it("reads id, method and section of every row", () => {
    const { rows, problems } = parseFeatureMap(table("| A1 | `a` thing | script | ok |", "| A2 | other | agent | x |"))
    expect(problems).toEqual([])
    expect(rows).toEqual([
      { id: "A1", method: "script", section: "Area", capability: "a thing" },
      { id: "A2", method: "agent", section: "Area", capability: "other" },
    ])
  })

  it("fails an unknown method cell and a malformed id", () => {
    const { problems } = parseFeatureMap(table("| A1 | a | agent (story S13) | x |", "| a-2 | b | script | x |"))
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('A1\'s method "agent (story S13)"')
    expect(problems[1]).toContain('malformed id "a-2"')
  })

  it("needs a gate check for every script row, and a row for every check id", () => {
    const { rows } = parseFeatureMap(
      table("| A1 | a | script | x |", "| A2 | b | script | x |", "| A3 | c | script | x |", "| A4 | d | agent | x |"),
    )
    const problems = consistency(rows, [
      { id: "A1-pi", tier: "gate", covers: ["A2"] },
      { id: "A3", tier: "slow", covers: [] },
      { id: "B9", tier: "gate", covers: [] },
      { id: "A4", tier: "agent", covers: [] },
    ])
    expect(problems).toEqual([
      "A3 is script, but no gate E2E check has its id or covers it",
      "E2E check B9 names B9, which is not in the feature map",
    ])
  })

  it("refuses a gate check for a row that is not script", () => {
    const { rows } = parseFeatureMap(table("| A1 | a | agent | x |"))
    expect(consistency(rows, [{ id: "A1", tier: "gate", covers: [] }])).toEqual([
      "gate E2E check A1 proves A1, whose method is agent, not script",
    ])
  })

  it("parses the real feature map without problems", () => {
    const text = fs.readFileSync(path.join(import.meta.dirname, "../../../docs/testing/feature-map.md"), "utf8")
    expect(parseFeatureMap(text).problems).toEqual([])
  })
})
