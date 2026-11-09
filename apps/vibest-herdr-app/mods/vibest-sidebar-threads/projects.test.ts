import type { PaneInfo, SpaceInfo, TabInfo } from "herdr"
import { describe, expect, it } from "vitest"

import { elapsed, parseFolded, pill, projects, relativeTime } from "./projects.ts"

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
  cwd: null,
  branch: null,
  status: null,
  app: null,
  program: shell,
  focused: false,
  zoomed: false,
  movable: false,
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

describe("parseFolded", () => {
  it("keeps the folded project ids and starts empty when the stored value is missing or corrupt", () => {
    expect(parseFolded('["sp1","sp2"]')).toEqual(["sp1", "sp2"])
    expect(parseFolded(null)).toEqual([])
    expect(parseFolded("{")).toEqual([])
    expect(parseFolded('{"sp1":true}')).toEqual([])
    expect(parseFolded('["sp1",3]')).toEqual(["sp1"])
  })
})

describe("projects", () => {
  it("nests each space's tabs as threads, hiding settled ones unless shown", () => {
    const spaces: SpaceInfo[] = [
      {
        id: "sp1",
        index: 1,
        name: "api",
        named: false,
        folder: "",
        machine: null,
        branch: null,
        active: true,
        status: "working",
        tabs: [
          tab({ id: "tb1", active: true, status: "working", changed_at: 5 }),
          tab({ id: "tb2", index: 2, settled: true }),
          tab({ id: "tb3", index: 3, name: "docs", named: true }),
        ],
      },
    ]
    const [api] = projects(spaces, [pane({ tab: "tb1", program: claude, title: "Plan" })])
    expect(api?.threads.map((t) => [t.id, t.title, t.active])).toEqual([
      ["tb1", "Plan", true],
      ["tb3", "docs", false],
    ])
    expect(api?.threads[0]?.changedAt).toBe(5)
  })
})
