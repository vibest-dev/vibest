import { h_flex } from "gpui-base"
import { type Context, div, type Element } from "gpui-kit"
import { panes, run, setShared, shared } from "herdr"

import { liveLayout, liveMetrics } from "./live-metrics.ts"
import { fitLayout, MAIN, mainChild } from "./metrics.ts"
import type { MachineMember, ProjectGroup } from "./project-groups.ts"
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

const SELECTED = "vibest.project"

export const selectedProject = (): string | null => {
  const key = shared(SELECTED)

  return key === undefined || key === null ? null : String(key)
}

const MACHINE = "vibest.machine"

const selectProject = (key: string | null, machine: string | null): void => {
  setShared(SELECTED, key)
  setShared(MACHINE, machine)
}

export const showSession = (s: VibestSession): boolean => {
  const terminal = s.terminal

  if (terminal === null) return false

  if (panes().some((p) => p.terminal === terminal)) run("pane.focus", { terminal })
  else run("terminal.peek", { terminal })

  return true
}

const RECENT = "vibest.recent"
const CHAT = "vibest.chat"
const KEPT = "vibest.chats"
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

const keptChats = (): string[] => {
  const list = shared(KEPT)

  return Array.isArray(list) ? list.map(String) : []
}

export const applyLayout = (): void => {
  const next = fitLayout(liveLayout(), liveMetrics(), { shown: mainChat(), kept: keptChats() })

  if (next) run("layout.set", { layout: next })
}

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

const showChat = (terminal: string | null): void => {
  if (terminal && !keptChats().includes(terminal)) setShared(KEPT, [...keptChats(), terminal].slice(-RECENT_KEEP))

  setShared(CHAT, terminal)
  applyLayout()
  run("layout.select", { stack: MAIN, child: mainChild(terminal) })

  if (terminal) run("pane.focus", { terminal })
}

export const openProject = (key: string, m: MachineMember, cx: Context): void => {
  selectProject(key, m.machine)
  setShared(RECENT, [key, ...recentProjects().filter((k) => k !== key)].slice(0, RECENT_KEEP))
  showChat(m.main?.terminal ?? null)

  if (!m.main?.terminal) launchMain(m, cx)
}

export const followProject = (groups: readonly ProjectGroup[]): void => {
  const key = selectedProject()
  const group = groups.find((g) => g.key === key)

  if (!group) return

  const m = group.members.find((member) => member.machine === shared(MACHINE)) ?? group.members[0]
  const terminal = m?.main?.terminal ?? null

  if (terminal !== mainChat()) showChat(terminal)
}

export const restoreChat = (): void => showChat(mainChat())

export const showSpace = (id: string): void => {
  selectProject(null, null)
  showChat(null)
  run("space.select", { id })
}
