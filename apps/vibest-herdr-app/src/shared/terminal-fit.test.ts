import { describe, expect, it } from "vitest"

import { fit, fitLayout } from "./terminal-fit.ts"

const tree = (bar: number, lights: number[], header = 40, bottom = 0) => ({
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
        { id: "bottom-gap", size: { px: bottom } },
      ],
    },
  ],
})

describe("fit", () => {
  const fixed = 30 + 16 + 2 + 34

  it("splits what whole terminal rows leave over in thirds: top bar, bottom gap, and the rest to the pane header", () => {
    expect(fit(tree(30, [13, 11]), fixed + 21 * 43, 14)).toEqual({
      bar: 30,
      header: 34,
      bottom: 0,
      pad: 8,
      searchTop: 10,
      lights: [13, 11],
    })
    expect(fit(tree(30, [13, 11]), fixed + 21 * 43 + 16, 14)).toEqual({
      bar: 35,
      header: 40,
      bottom: 5,
      pad: 8,
      searchTop: 13,
      lights: [13, 14],
    })
    expect(fit(tree(30, [13, 11]), fixed + 21 * 43 + 20.6, 14)).toMatchObject({ bar: 36, header: 42, bottom: 6 })
  })
})

describe("fitLayout", () => {
  const f = { bar: 35, header: 40, bottom: 5, pad: 8, searchTop: 13, lights: [13, 14] as const }

  it("resizes the bars, the pane header and the bottom gap, and moves the traffic lights", () => {
    expect(fitLayout(tree(30, [13, 11]), f)).toEqual(tree(35, [13, 14], 40, 5))
  })

  it("returns nothing when the layout already fits", () => {
    expect(fitLayout(tree(35, [13, 14], 40, 5), f)).toBeNull()
    expect(fitLayout(null, f)).toBeNull()
  })
})
