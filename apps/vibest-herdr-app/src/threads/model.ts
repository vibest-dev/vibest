import type { PaneInfo, SpaceInfo, Status, TabInfo } from "herdr"

export interface Thread {
  readonly id: string
  readonly title: string
  readonly active: boolean
  readonly status: Status | null
  readonly changedAt: number | null
  readonly workingSince: number | null
}

export interface Project {
  readonly id: string
  readonly name: string
  readonly machine: string | null
  readonly active: boolean
  readonly status: Status | null
  readonly threads: readonly Thread[]
}

const leading = (s: string): string => s.replace(/^[^\p{L}\p{N}]+/u, "").trim()
const looksLikePath = (s: string): boolean => /^[~/]|^[A-Za-z]:\\/.test(s) || s.includes("@")

export const parseFolded = (stored: string | null): string[] => {
  try {
    const value: unknown = JSON.parse(stored ?? "[]")
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

export const threadTitle = (tab: TabInfo, tabPanes: readonly PaneInfo[]): string => {
  if (tab.named) return tab.name
  const lead = tabPanes.find((p) => p.program?.agent) ?? tabPanes.find((p) => p.terminal) ?? tabPanes[0]
  const raw = (lead?.title ?? "").trim()
  const live = leading(raw)
  if (live && live !== lead?.terminal && !looksLikePath(raw) && live.toLowerCase() !== lead?.program?.key) return live
  return lead?.program?.agent ? lead.program.name : `Terminal ${tab.index}`
}

export const projects = (spaces: readonly SpaceInfo[], panes: readonly PaneInfo[]): Project[] => {
  const byTab = new Map<string, PaneInfo[]>()
  for (const p of panes) {
    const list = byTab.get(p.tab)
    if (list) list.push(p)
    else byTab.set(p.tab, [p])
  }
  return spaces.map((s) => ({
    id: s.id,
    name: s.name,
    machine: s.machine,
    active: s.active,
    status: s.status,
    threads: s.tabs
      .filter((t) => !t.settled || t.active)
      .map((t) => ({
        id: t.id,
        title: threadTitle(t, byTab.get(t.id) ?? []),
        active: s.active && t.active,
        status: t.status,
        changedAt: t.changed_at,
        workingSince: t.working_since,
      })),
  }))
}

export const relativeTime = (at: number | null, now: number): string => {
  if (at === null) return ""
  const seconds = Math.floor(Math.max(0, now - at) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export const elapsed = (since: number | null, now: number): string => {
  if (since === null) return ""
  const minutes = Math.floor(Math.max(0, now - since) / 60000)
  if (minutes < 1) return ""
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}

export interface Pill {
  readonly label: string
  readonly tone: Status
  readonly pulse: boolean
}

const PILLS: Partial<Record<Status, Pill>> = {
  working: { label: "Working", tone: "working", pulse: true },
  blocked: { label: "Awaiting Input", tone: "blocked", pulse: false },
  done: { label: "Done", tone: "done", pulse: false },
}

export const pill = (status: Status | null): Pill | null => (status === null ? null : (PILLS[status] ?? null))
