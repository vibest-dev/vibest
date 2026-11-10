import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { consistency, readFeatures } from "../src/feature-ids.ts"

const featuresDir = path.join(import.meta.dirname, "../../../docs/features")

const area = (...ids: ReadonlyArray<string>) => ({
  file: "area.md",
  text: ["# Area", "", ...ids.flatMap((id) => [`## ${id}. Something`, "", "Works when it does.", ""])].join("\n"),
})

describe("feature ids", () => {
  it("reads each capability heading's id", () => {
    expect(readFeatures([area("A1", "A2")])).toEqual({
      features: [
        { id: "A1", title: "Something", file: "area.md" },
        { id: "A2", title: "Something", file: "area.md" },
      ],
      problems: [],
    })
  })

  it("fails a malformed heading and a repeated id", () => {
    const { problems } = readFeatures([{ file: "a.md", text: "## a-1 thing\n## A1. x\n## A1. y" }])
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('not "## a-1 thing"')
    expect(problems[1]).toContain("A1 is already a capability")
  })

  it("needs a gate check for each id not proven by hand, and a feature for each check id", () => {
    const { features } = readFeatures([area("A1", "A2", "A3", "D9", "I5", "I10", "S39", "U3")])
    expect(
      consistency(features, [
        { id: "A1-pi", tier: "gate", covers: ["A2"] },
        { id: "A3", tier: "slow", covers: [] },
        { id: "B9", tier: "gate", covers: [] },
        { id: "I5", tier: "agent", covers: [] },
      ]),
    ).toEqual([
      "A3 (area.md) has no gate E2E check proving it and is not proven by hand",
      "E2E check B9 names B9, which no file in docs/features has",
    ])
  })

  it("fails an id proven by hand that a gate check proves", () => {
    const { features } = readFeatures([area("D9", "I5", "I10", "S39", "U3")])
    expect(consistency(features, [{ id: "S39", tier: "gate", covers: [] }])).toEqual([
      "S39 is listed in tools/verify as proven by hand, but a gate E2E check proves it",
    ])
  })

  it("reads the real feature files without problems", () => {
    const files = fs
      .readdirSync(featuresDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ file: f, text: fs.readFileSync(path.join(featuresDir, f), "utf8") }))
    expect(readFeatures(files).problems).toEqual([])
  })
})
