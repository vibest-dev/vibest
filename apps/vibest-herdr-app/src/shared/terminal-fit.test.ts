import { describe, expect, it } from "vitest"

import { barExtra, FIXED_HEIGHT } from "./terminal-fit.ts"

describe("barExtra", () => {
  it("gives the top bar what whole terminal rows leave over", () => {
    expect(barExtra(FIXED_HEIGHT + 21 * 43, 14)).toBe(0)
    expect(barExtra(FIXED_HEIGHT + 21 * 43 + 7, 14)).toBe(7)
    expect(barExtra(FIXED_HEIGHT + 21 * 43 + 20.6, 14)).toBe(20)
    expect(barExtra(FIXED_HEIGHT + 18 * 10 + 3, 12)).toBe(3)
  })
})
