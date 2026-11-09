import { describe, expect, it } from "vitest"

import { barExtra, FIXED_HEIGHT, fitLayout } from "./terminal-fit.ts"

describe("barExtra", () => {
  it("gives the top bar what whole terminal rows leave over", () => {
    expect(barExtra(FIXED_HEIGHT + 21 * 43, 14)).toBe(0)
    expect(barExtra(FIXED_HEIGHT + 21 * 43 + 7, 14)).toBe(7)
    expect(barExtra(FIXED_HEIGHT + 21 * 43 + 20.6, 14)).toBe(20)
    expect(barExtra(FIXED_HEIGHT + 18 * 10 + 3, 12)).toBe(3)
  })
})

describe("fitLayout", () => {
  const tree = (bar: number, lights: number[]) => ({
    id: "root",
    traffic_lights: lights,
    children: [
      { id: "sidebar", children: [{ id: "sidebar-header", size: { px: bar } }, { id: "threads" }] },
      { id: "workspace", children: [{ id: "topbar", size: { px: bar } }, { id: "body" }] },
    ],
  })

  it("grows both bars and moves the traffic lights down by half the extra", () => {
    expect(fitLayout(tree(32, [13, 12]), 7)).toEqual(tree(39, [13, 15]))
  })

  it("returns nothing when the layout already fits", () => {
    expect(fitLayout(tree(39, [13, 15]), 7)).toBeNull()
    expect(fitLayout(null, 7)).toBeNull()
  })
})
