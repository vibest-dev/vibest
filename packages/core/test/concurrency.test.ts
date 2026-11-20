import { describe, expect, it } from "@effect/vitest"
import { rulesOf } from "@vibest/core/concurrency"

describe("concurrency rules", () => {
  it("applies the smallest whole-machine max and no limit without the key", () => {
    expect(rulesOf(undefined)).toEqual({ max: undefined, problems: [], unsupported: [] })
    expect(rulesOf([{ max: 4 }, { max: 2 }]).max).toBe(2)
  })

  it("never applies a filtered rule as a whole-machine rule", () => {
    const rules = rulesOf([{ max: 4 }, { harness: "claude", max: 1 }, { agent: "reviewer", max: 1 }])
    expect(rules.max).toBe(4)
    expect(rules.problems).toEqual([])
    expect(rules.unsupported).toHaveLength(2)
  })

  it("reports unknown fields, a max that is not a positive integer, and a key that is not a list, and applies none of them", () => {
    const rules = rulesOf([{ max: 3, harnes: "claude" }, { max: 0 }, { max: 1.5 }, { max: "2" }, "max", { max: 5 }])
    expect(rules.max).toBe(5)
    expect(rules.problems).toHaveLength(5)
    expect(rules.problems[0]).toContain("unknown fields: harnes")
    expect(rulesOf({ max: 1 })).toMatchObject({ max: undefined, problems: [expect.stringContaining("not a list")] })
  })
})
