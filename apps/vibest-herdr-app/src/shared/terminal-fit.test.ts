import { describe, expect, it } from "vitest"

import { fit, fitLayout } from "./terminal-fit.ts"

const tree = (bar: number, lights: number[], header = 40) => ({
  id: "root",
  traffic_lights: lights,
  children: [
    { id: "sidebar", children: [{ id: "sidebar-header", size: { px: bar } }] },
    {
      id: "workspace",
      children: [
        { id: "topbar", size: { px: bar } },
        {
          id: "workspace-body",
          padding: [8, 0],
          children: [{ id: "terminals", content: { pane: { border: { width: 1 }, header: { height: header } } } }],
        },
      ],
    },
  ],
})

describe("fit", () => {
  const fixed = 32 + 16 + 2 + 36

  it("splits what whole terminal rows leave over between the bars and the pane header", () => {
    expect(fit(tree(32, [13, 12]), fixed + 21 * 43, 14)).toEqual({
      bar: 32,
      header: 36,
      pad: 8,
      searchTop: 11,
      lights: [13, 12],
    })
    expect(fit(tree(32, [13, 12]), fixed + 21 * 43 + 11, 14)).toEqual({
      bar: 37,
      header: 42,
      pad: 8,
      searchTop: 14,
      lights: [13, 15],
    })
    expect(fit(tree(32, [13, 12]), fixed + 21 * 43 + 20.6, 14)).toMatchObject({ bar: 42, header: 46 })
  })
})

describe("fitLayout", () => {
  const f = { bar: 37, header: 42, pad: 8, searchTop: 14, lights: [13, 15] as const }

  it("resizes both bars and the pane header, and moves the traffic lights", () => {
    expect(fitLayout(tree(32, [13, 12]), f)).toEqual(tree(37, [13, 15], 42))
  })

  it("returns nothing when the layout already fits", () => {
    expect(fitLayout(tree(37, [13, 15], 42), f)).toBeNull()
    expect(fitLayout(null, f)).toBeNull()
  })
})
