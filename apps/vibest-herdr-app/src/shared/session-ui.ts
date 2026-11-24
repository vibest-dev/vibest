import { h_flex } from "gpui-base"
import { div, type Element } from "gpui-kit"
import { panes, run, setShared, shared } from "herdr"

import { liveLayout, liveMetrics } from "./live-metrics.ts"
import { fitLayout } from "./metrics.ts"
import type { MachineMember } from "./project-groups.ts"
import { SMALL } from "./text-size.ts"
import type { Theme } from "./theme-colors.ts"
import { LOCAL, type VibestSession } from "./vibest-model.ts"

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

export const herdrTerminal = (s: VibestSession): string | null => {
  const id = s.terminal.split("@")[0] ?? ""

  if (!/^t[0-9a-z]+$/.test(id)) return null

  return s.machine === LOCAL ? id : `${s.machine}/${id}`
}

const SELECTED = "vibest.project"

export const selectedProject = (): string | null => {
  const key = shared(SELECTED)

  return key === undefined || key === null ? null : String(key)
}

export const selectProject = (key: string): void => {
  setShared(SELECTED, key)
}

export const showSession = (s: VibestSession): boolean => {
  const terminal = herdrTerminal(s)

  if (terminal === null) return false

  if (panes().some((p) => p.terminal === terminal)) run("pane.focus", { terminal })
  else run("terminal.peek", { terminal })

  return true
}

const RECENT = "vibest.recent"
const CHAT = "vibest.chat"
const RECENT_KEEP = 8

const recentProjects = (): string[] => {
  const list = shared(RECENT)

  return Array.isArray(list) ? list.map(String) : []
}

export const previousProject = (): string | null => recentProjects()[1] ?? null

export const mainChat = (): string | null => {
  const chat = String(shared(CHAT) ?? "")

  return chat === "" ? null : chat
}

export const applyLayout = (): void => {
  const next = fitLayout(liveLayout(), liveMetrics(), mainChat())

  if (next) run("layout.set", { layout: next })
}

export const openProject = (key: string, m: MachineMember): void => {
  const terminal = m.entry ? herdrTerminal(m.entry) : null

  selectProject(key)
  setShared(RECENT, [key, ...recentProjects().filter((k) => k !== key)].slice(0, RECENT_KEEP))
  setShared(CHAT, terminal)
  applyLayout()

  if (terminal) run("pane.focus", { terminal })
}

export const showSpace = (id: string): void => {
  setShared(CHAT, null)
  setShared(SELECTED, null)
  applyLayout()
  run("space.select", { id })
}
