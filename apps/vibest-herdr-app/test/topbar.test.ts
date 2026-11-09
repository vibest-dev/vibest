import type { PaneInfo, SpaceInfo, TabInfo } from "herdr"
import { describe, expect, it } from "vitest"

import { topbarState } from "../src/workspace/topbar/topbar-state.ts"

const tab: TabInfo = {
  id: "tb1",
  index: 1,
  name: "fix login",
  named: true,
  active: true,
  status: null,
  panes: 1,
  zoomed: false,
  settled: false,
  settled_at: null,
  changed_at: null,
  working_since: null,
}
const space: SpaceInfo = {
  id: "sp1",
  index: 1,
  name: "api",
  named: false,
  folder: "",
  machine: null,
  branch: "main",
  active: true,
  status: null,
  tabs: [tab],
}
const layout = (panel: { hidden: boolean; active: string }, sidebarHidden = false) => ({
  id: "root",
  children: [
    { id: "sidebar", hidden: sidebarHidden },
    { id: "workspace", children: [{ id: "right-panel", ...panel }] },
  ],
})
const none: PaneInfo[] = []

describe("topbarState", () => {
  it("names the shown project, thread and branch, and the shown right panel child", () => {
    expect(topbarState(layout({ hidden: false, active: "agents" }), [space], none)).toEqual({
      breadcrumb: { project: "api", thread: "fix login", branch: "main" },
      shownPanel: "agents",
      sidebarHidden: false,
    })
  })

  it("has no shown panel while the right panel is hidden, and no breadcrumb without a shown space", () => {
    const state = topbarState(layout({ hidden: true, active: "files" }, true), [], none)
    expect(state).toEqual({ breadcrumb: null, shownPanel: null, sidebarHidden: true })
  })
})
