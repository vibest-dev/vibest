import type { PaneInfo, SpaceInfo, TabInfo } from "herdr"
import { describe, expect, it } from "vitest"

import { elapsed, parseExpanded, pill, projectName, projects, relativeTime } from "./projects.ts"

const program = { icon: null as string | null, tint: false, tile: null as string | null, color: null as string | null }
const shell = { ...program, key: "shell", name: "zsh", agent: false, shell: true }
const claude = { ...program, key: "claude", name: "Claude Code", agent: true, shell: false }

const tab = (over: Partial<TabInfo> = {}): TabInfo => ({
  id: "tb1",
  index: 1,
  name: "1",
  named: false,
  active: false,
  status: null,
  panes: 1,
  settled: false,
  settled_at: null,
  zoomed: false,
  changed_at: null,
  working_since: null,
  ...over,
})

const pane = (over: Partial<PaneInfo> = {}): PaneInfo => ({
  pane: "p1",
  terminal: "t1",
  tab: "tb1",
  title: "",
  name: null,
  cwd: null,
  branch: null,
  status: null,
  app: null,
  program: shell,
  focused: false,
  zoomed: false,
  movable: false,
  scroll: null,
  ...over,
})

describe("relativeTime", () => {
  it("uses T3 Code's buckets: just now, then minutes, hours and days ago", () => {
    const now = 10 * 86_400_000

    expect(relativeTime(now - 59_000, now)).toBe("just now")
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago")
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago")
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago")
  })

  it("shows nothing for a tab that has not changed since the app started", () => {
    expect(relativeTime(null, 0)).toBe("")
  })
})

describe("elapsed", () => {
  it("counts a working thread's time in whole minutes, then hours, and stays quiet under a minute", () => {
    expect(elapsed(0, 59_000)).toBe("")
    expect(elapsed(0, 3 * 60_000)).toBe("3m")
    expect(elapsed(0, 125 * 60_000)).toBe("2h")
    expect(elapsed(null, 1)).toBe("")
  })
})

describe("pill", () => {
  it("labels the statuses that need a look and hides idle", () => {
    expect(pill("working")?.label).toBe("Working")
    expect(pill("blocked")?.label).toBe("Awaiting Input")
    expect(pill("done")?.label).toBe("Done")
    expect(pill("idle")).toBeNull()
    expect(pill(null)).toBeNull()
  })
})

describe("projectName", () => {
  it("strips a redundant Vibest/ prefix from space names", () => {
    expect(projectName("Vibest/api")).toBe("api")
    expect(projectName("api")).toBe("api")
    expect(projectName("Vibest/")).toBe("Vibest/")
  })
})

describe("parseExpanded", () => {
  it("keeps the expanded project ids and starts empty when the stored value is missing or corrupt", () => {
    expect(parseExpanded('["sp1","sp2"]')).toEqual(["sp1", "sp2"])
    expect(parseExpanded(null)).toEqual([])
    expect(parseExpanded("{")).toEqual([])
    expect(parseExpanded('{"sp1":true}')).toEqual([])
    expect(parseExpanded('["sp1",3]')).toEqual(["sp1"])
  })
})

describe("projects", () => {
  it("builds selectable projects with cleaned names, aggregate status timestamps and Vibest entry primary tab", () => {
    const spaces: SpaceInfo[] = [
      {
        id: "sp1",
        index: 1,
        name: "Vibest/api",
        named: false,
        folder: "",
        machine: null,
        branch: null,
        active: true,
        status: "working",
        tabs: [
          tab({ id: "tb1", active: true, status: "working", changed_at: 5, working_since: 2 }),
          tab({ id: "tb2", index: 2, settled: true }),
          tab({ id: "tb3", index: 3, name: "Vibest/api", named: true, changed_at: 9 }),
        ],
      },
    ]

    const [api] = projects(spaces, [pane({ tab: "tb1", program: claude, title: "Plan" })])

    expect(api?.name).toBe("api")
    expect(api?.primaryTabId).toBe("tb3")
    expect(api?.changedAt).toBe(9)
    expect(api?.workingSince).toBe(2)
    expect(api?.threads.map((t) => [t.id, t.title, t.active])).toEqual([
      ["tb1", "Plan", true],
      ["tb3", "Vibest/api", false],
    ])
  })

  it("falls back to the active tab when no Vibest entry tab exists", () => {
    const spaces: SpaceInfo[] = [
      {
        id: "sp2",
        index: 2,
        name: "web",
        named: true,
        folder: "",
        machine: "vps",
        branch: "main",
        active: false,
        status: "idle",
        tabs: [tab({ id: "tb1", index: 1 }), tab({ id: "tb2", index: 2, active: true })],
      },
    ]

    const [web] = projects(spaces, [])

    expect(web?.primaryTabId).toBe("tb2")
    expect(web?.machine).toBe("vps")
  })
})
