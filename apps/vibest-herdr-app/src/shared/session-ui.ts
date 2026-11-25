import { h_flex } from "gpui-base"
import { type Context, div, type Element } from "gpui-kit"
import { focused, hc, type PaneInfo, panes, run, setShared, shared } from "herdr"

import type { MachineMember, ProjectGroup } from "./project-groups.ts"
import { isProjectTab, local, PROJECT_SPACE, TAB_PREFIX } from "./project-space.ts"
import { SMALL } from "./text-size.ts"
import type { Theme } from "./theme-colors.ts"
import { LOCAL, type VibestSession } from "./vibest-model.ts"
import { launch } from "./vibest-source.ts"

export const relativeTime = (at: number | null, now: number): string => {
  if (at === null) return ""

  const minutes = Math.floor(Math.max(0, now - at) / 60_000)

  if (minutes < 1) return "now"

  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

const labelOf = (status: string): string | null => {
  switch (status) {
    case "working":
      return "Working"
    case "blocked":
      return "Needs you"
    case "done":
      return "Done"
    default:
      return null
  }
}

export const statusMark = (t: Theme, status: string, lastActive: number | null, now: number): Element => {
  const label = labelOf(status)

  if (label === null) return div().text_size(SMALL()).text_color(t.dim).child(relativeTime(lastActive, now))

  const color = t[status] ?? t.foreground
  const dot = div().size(8).flex_none().rounded_full().bg(color)

  return h_flex()
    .gap(8)
    .items_center()
    .text_size(SMALL())
    .font_medium()
    .text_color(color)
    .child(status === "working" ? dot.loop("opacity", { from: 0.5, to: 1, period: 2000 }) : dot)
    .child(label)
}

const RECENT = "vibest.recent"
const RECENT_KEEP = 8
const FOCUS_TRIES = 30
const FOCUS_MS = 100

const projectTab = (m: MachineMember): string => `${TAB_PREFIX}${m.project.id}`

const focusedProjectId = (): string | null => {
  const tab = local(focused()?.tab ?? "")

  return tab.startsWith(TAB_PREFIX) ? tab.slice(TAB_PREFIX.length) : null
}

export const selectedProject = (groups: readonly ProjectGroup[]): string | null => {
  const id = focusedProjectId()
  const terminal = focused()?.terminal ?? null

  return (
    groups.find((g) => g.members.some((m) => m.project.id === id || (terminal && m.main?.terminal === terminal)))
      ?.key ?? null
  )
}

export const showSession = (s: VibestSession): boolean => {
  const terminal = s.terminal

  if (terminal === null) return false

  if (panes().some((p) => p.terminal === terminal)) run("pane.focus", { terminal })
  else run("terminal.peek", { terminal })

  return true
}

const recentProjects = (): string[] => {
  const list = shared(RECENT)

  return Array.isArray(list) ? list.map(String) : []
}

export const previousProject = (): string | null => recentProjects()[1] ?? null

const launching = new Set<string>()

const launchMain = (m: MachineMember, cx: Context): void => {
  if (m.machine !== LOCAL || launching.has(m.project.id)) return

  launching.add(m.project.id)
  cx.spawn(async (): Promise<void> => {
    await launch({ projectId: m.project.id, sessionId: m.main?.id, runtime: "hc", focus: false }).catch(
      (): undefined => undefined,
    )
    launching.delete(m.project.id)
  })
}

const paneOf = (terminal: string): PaneInfo | undefined => panes().find((p) => p.terminal === terminal)

const adopt = (terminal: string, m: MachineMember): void => {
  if (paneOf(terminal)) return

  hc(["label", terminal, `herdr.space=${PROJECT_SPACE}`, `herdr.tab=${projectTab(m)}`]).catch(
    (): undefined => undefined,
  )
}

const focusWhenShown = (terminal: string, label: string, cx: Context, tries = FOCUS_TRIES): void => {
  const pane = paneOf(terminal)

  if (pane) {
    if (isProjectTab(pane.tab)) run("tab.rename", { id: pane.tab, name: label })

    run("pane.focus", { terminal })

    return
  }

  if (tries > 0) cx.timer.after(FOCUS_MS, (next) => focusWhenShown(terminal, label, next, tries - 1))
}

export const openProject = (key: string, label: string, m: MachineMember, cx: Context): void => {
  const terminal = m.main?.terminal ?? null

  setShared(RECENT, [key, ...recentProjects().filter((k) => k !== key)].slice(0, RECENT_KEEP))

  if (terminal === null) return launchMain(m, cx)

  adopt(terminal, m)
  focusWhenShown(terminal, label, cx)
}

export const followProjects = (groups: readonly ProjectGroup[]): void => {
  const tabs = new Set(panes().map((p) => local(p.tab)))

  for (const m of groups.flatMap((g) => g.members)) {
    if (m.main?.terminal && tabs.has(projectTab(m))) adopt(m.main.terminal, m)
  }
}
