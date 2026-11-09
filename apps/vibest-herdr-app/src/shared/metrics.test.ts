import { describe, expect, it } from "vitest"

import { fitLayout, metrics } from "./metrics.ts"

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

describe("metrics", () => {
  const fixed = 30 + 8 + 1 + 36 + 8 + 1 + 8

  it("gives a third of what whole terminal rows leave over to the bars and the rest to the pane head", () => {
    expect(metrics(tree(30, [13, 11]), fixed + 21 * 43, 14)).toEqual({
      bar: 30,
      pad: 8,
      head: 36,
      searchTop: 11,
      lights: [13, 11],
    })
    expect(metrics(tree(30, [13, 11]), fixed + 21 * 43 + 6, 14)).toEqual({
      bar: 32,
      pad: 8,
      head: 40,
      searchTop: 13,
      lights: [13, 12],
    })
    expect(metrics(tree(30, [13, 11]), fixed + 21 * 43 + 20.6, 14)).toMatchObject({ bar: 36, head: 50 })
  })
})

describe("fitLayout", () => {
  const m = { bar: 32, pad: 8, head: 40, searchTop: 13, lights: [13, 12] as const }

  it("resizes the bars and the pane header, and moves the traffic lights", () => {
    expect(fitLayout(tree(30, [13, 11]), m)).toEqual(tree(32, [13, 12], 32))
  })

  it("returns nothing when the layout already fits", () => {
    expect(fitLayout(tree(32, [13, 12], 32), m)).toBeNull()
    expect(fitLayout(null, m)).toBeNull()
  })
})
