import type { PaneInfo, TabInfo } from "herdr"
import { describe, expect, it } from "vitest"

import { threadTitle } from "./thread-title.ts"

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

describe("threadTitle", () => {
  it("keeps a name someone gave the tab", () => {
    expect(threadTitle(tab({ name: "fix login", named: true }), [pane({ title: "vim" })])).toBe("fix login")
  })

  it("names an unnamed tab after its agent's live title, else the agent", () => {
    expect(threadTitle(tab(), [pane({ program: claude, title: "✳ Refactor auth" })])).toBe("Refactor auth")
    expect(threadTitle(tab(), [pane({ program: claude, title: "~/src/app" })])).toBe("Claude Code")
  })

  it("falls back to Terminal and the tab's place for a bare shell", () => {
    expect(threadTitle(tab({ index: 2 }), [pane({ title: "dinq@mac: ~" })])).toBe("Terminal 2")
    expect(threadTitle(tab({ index: 3 }), [])).toBe("Terminal 3")
    expect(threadTitle(tab({ index: 4 }), [pane({ terminal: "t7", title: "t7" })])).toBe("Terminal 4")
  })
})
