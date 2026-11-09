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
