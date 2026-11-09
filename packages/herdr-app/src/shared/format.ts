import type { Status } from "herdr"

import type { SessionRow } from "./vibest.ts"

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

export const sessionStatus = (row: SessionRow): string =>
  row.turnState === "" || row.turnState === "none" ? row.status : `${row.status}/${row.turnState}`
