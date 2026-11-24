import type { PaneInfo, SpaceInfo, Status } from "herdr"

import { threadTitle } from "../../shared/thread-title.ts"

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
  readonly changedAt: number | null
  readonly workingSince: number | null
  readonly primaryTabId: string | null
  readonly threads: readonly Thread[]
}

const VIBEST_PREFIX = "Vibest/"

export const projectName = (name: string): string => {
  if (!name.startsWith(VIBEST_PREFIX)) return name

  const stripped = name.slice(VIBEST_PREFIX.length).trim()

  return stripped === "" ? name : stripped
}

type JsonItem =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly JsonItem[]
  | { readonly [key: string]: JsonItem }

const isString = (value: JsonItem): value is string => Object.prototype.toString.call(value) === "[object String]"

export const parseExpanded = (stored: string | null): string[] => {
  try {
    const value: readonly JsonItem[] = JSON.parse(stored ?? "[]")

    return Array.isArray(value) ? value.filter(isString) : []
  } catch {
    return []
  }
}

const latestChange = (threads: readonly Thread[]): number | null => {
  let latest: number | null = null

  for (const t of threads) {
    if (t.changedAt !== null && (latest === null || t.changedAt > latest)) latest = t.changedAt
  }

  return latest
}

const earliestWorking = (threads: readonly Thread[]): number | null => {
  let earliest: number | null = null

  for (const t of threads) {
    if (t.status === "working" && t.workingSince !== null && (earliest === null || t.workingSince < earliest)) {
      earliest = t.workingSince
    }
  }

  return earliest
}

const selectPrimaryTab = (name: string, threads: readonly Thread[], activeTabId: string | null): string | null => {
  const entryLabel = `${VIBEST_PREFIX}${name}`
  const entry = threads.find((t) => t.title === entryLabel || t.title.startsWith(VIBEST_PREFIX))

  if (entry) return entry.id

  if (activeTabId !== null) return activeTabId

  return threads[0]?.id ?? null
}

export const projects = (spaces: readonly SpaceInfo[], panes: readonly PaneInfo[]): Project[] => {
  const byTab = new Map<string, PaneInfo[]>()

  for (const p of panes) {
    const list = byTab.get(p.tab)

    if (list) list.push(p)
    else byTab.set(p.tab, [p])
  }

  return spaces.map((s) => {
    const name = projectName(s.name)
    const threads: Thread[] = []
    let activeTabId: string | null = null

    for (const t of s.tabs) {
      if (t.settled && !t.active) continue

      if (t.active) activeTabId = t.id

      threads.push({
        id: t.id,
        title: threadTitle(t, byTab.get(t.id) ?? []),
        active: s.active && t.active,
        status: t.status,
        changedAt: t.changed_at,
        workingSince: t.working_since,
      })
    }

    return {
      id: s.id,
      name,
      machine: s.machine,
      active: s.active,
      status: s.status,
      changedAt: latestChange(threads),
      workingSince: earliestWorking(threads),
      primaryTabId: selectPrimaryTab(name, threads, activeTabId),
      threads,
    }
  })
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
