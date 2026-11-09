export function relativeTime(at, now) {
  if (at == null) return ""
  const seconds = Math.floor(Math.max(0, now - at) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function elapsed(since, now) {
  if (since == null) return ""
  const minutes = Math.floor(Math.max(0, now - since) / 60000)
  if (minutes < 1) return ""
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}

export const PILLS = {
  working: { label: "Working", tone: "working", pulse: true },
  blocked: { label: "Awaiting Input", tone: "blocked", pulse: false },
  done: { label: "Done", tone: "done", pulse: false },
}

export function pill(status) {
  return PILLS[status] ?? null
}

const leading = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim()
const looksLikePath = (s) => /^[~/]|^[A-Za-z]:\\/.test(s) || s.includes("@")

export function threadTitle(tab, tabPanes) {
  if (tab.named) return tab.name
  const lead = tabPanes.find((p) => p.program?.agent) ?? tabPanes.find((p) => p.terminal) ?? tabPanes[0]
  const raw = (lead?.title ?? "").trim()
  const live = leading(raw)
  if (live && live !== lead?.terminal && !looksLikePath(raw) && live.toLowerCase() !== lead?.program?.key) return live
  return lead?.program?.agent ? lead.program.name : `Terminal ${tab.index}`
}

export function projects(spaces, panes) {
  const byTab = new Map()
  for (const p of panes) {
    const list = byTab.get(p.tab)
    list ? list.push(p) : byTab.set(p.tab, [p])
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
