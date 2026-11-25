import { describe, expect, it } from "vitest"

import { fitLayout, metrics } from "./metrics.ts"

const tree = (bar: number, lights: number[], header = 40) => ({
  id: "root",
  traffic_lights: lights,
  terminal_padding: [4, 4],
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
  it("keeps the bars at 32 and the pane head at 24 plus 4 above and below it, whatever the window height", () => {
    expect(metrics(tree(30, [13, 11]))).toEqual({ bar: 32, pad: 8, head: 32, searchTop: 9, lights: [13, 12] })
  })
})

describe("fitLayout", () => {
  const m = { bar: 32, pad: 8, head: 32, searchTop: 13, lights: [13, 12] as const }

  it("resizes the bars and the pane header, and moves the traffic lights", () => {
    expect(fitLayout(tree(30, [13, 11]), m)).toEqual(tree(32, [13, 12], 28))
  })

  it("returns nothing when the layout already fits", () => {
    expect(fitLayout(tree(32, [13, 12], 28), m)).toBeNull()
    expect(fitLayout(null, m)).toBeNull()
  })
})

describe("left gutter", () => {
  const m = { bar: 32, pad: 8, head: 32, searchTop: 13, lights: [13, 12] as const }

  const layout = (sidebarHidden: boolean, gutterHidden: boolean) => ({
    ...tree(32, [13, 12], 28),
    children: [
      { id: "sidebar", hidden: sidebarHidden },
      { id: "left-gutter", hidden: gutterHidden },
    ],
  })

  it("shows only while the sidebar is hidden, so the panes never touch the window edge", () => {
    expect(fitLayout(layout(true, true), m)?.children?.[1]).toEqual({ id: "left-gutter", hidden: false })
    expect(fitLayout(layout(false, false), m)?.children?.[1]).toEqual({ id: "left-gutter", hidden: true })
    expect(fitLayout(layout(false, true), m)).toBeNull()
  })
})

describe("main chat", () => {
  const m = { bar: 32, pad: 8, head: 32, searchTop: 13, lights: [13, 12] as const }
  const chat = { id: "chat", radius: 8, content: { terminal: "" } }

  const layout = (active: string, kept: readonly string[]) => ({
    ...tree(32, [13, 12], 28),
    children: [
      {
        id: "main",
        active,
        children: [
          { id: "terminals" },
          chat,
          ...kept.map((t) => ({ ...chat, id: `chat-${t.replaceAll("/", "-")}`, content: { terminal: t } })),
        ],
      },
    ],
  })

  it("keeps a block per recent main conversation and shows the current one", () => {
    expect(fitLayout(layout("terminals", []), m, { shown: "mac-mini/t1pk", kept: ["mac-mini/t1pk", "t7"] })).toEqual(
      layout("chat-mac-mini-t1pk", ["mac-mini/t1pk", "t7"]),
    )
  })

  it("falls back to the tabs and keeps the blocks when no main conversation is shown", () => {
    expect(fitLayout(layout("chat-t7", ["t7"]), m, { shown: null, kept: ["t7"] })).toEqual(layout("terminals", ["t7"]))
    expect(fitLayout(layout("chat-t7", ["t7"]), m, { shown: "t7", kept: ["t7"] })).toBeNull()
  })
})
