import { describe, expect, it } from "vitest"

import { fit, fitLayout } from "./terminal-fit.ts"

const tree = (bar: number, lights: number[], header = 40) => ({
  id: "root",
  traffic_lights: lights,
  terminal_padding: [8, 8],
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
  const fixed = 30 + 16 + 2 + 28 + 16

  it("gives a third of what whole terminal rows leave over to the bars and the rest to the pane header", () => {
    expect(fit(tree(30, [13, 11]), fixed + 21 * 43, 14)).toEqual({
      bar: 30,
      header: 28,
      inset: 8,
      pad: 8,
      searchTop: 11,
      lights: [13, 11],
    })
    expect(fit(tree(30, [13, 11]), fixed + 21 * 43 + 6, 14)).toEqual({
      bar: 32,
      header: 32,
      inset: 8,
      pad: 8,
      searchTop: 13,
      lights: [13, 12],
    })
    expect(fit(tree(30, [13, 11]), fixed + 21 * 43 + 20.6, 14)).toMatchObject({ bar: 36, header: 42 })
  })
})

describe("fitLayout", () => {
  const f = { bar: 32, header: 32, inset: 8, pad: 8, searchTop: 13, lights: [13, 12] as const }

  it("resizes the bars and the pane header, and moves the traffic lights", () => {
    expect(fitLayout(tree(30, [13, 11]), f)).toEqual(tree(32, [13, 12], 32))
  })

  it("returns nothing when the layout already fits", () => {
    expect(fitLayout(tree(32, [13, 12], 32), f)).toBeNull()
    expect(fitLayout(null, f)).toBeNull()
  })
})
