import type { SessionRow } from "./cli.ts"

export interface SessionGroup {
  readonly projectId: string
  readonly label: string
  readonly sessions: readonly SessionRow[]
}

export interface Pull {
  readonly token: number
  readonly closed: boolean
  readonly running: boolean
  readonly again: boolean
}

export const idlePull = (): Pull => ({ token: 0, closed: false, running: false, again: false })

export const rowNote = (session: SessionRow): string => {
  if (session.runtime !== "hc") return `runtime ${session.runtime || "unknown"}`
  if (session.machine !== "local") return "on another machine"
  if (session.socket === "" || session.coreAddress.includes("/")) return "no local terminal"
  return ""
}

export const shortId = (row: SessionRow): string => row.id.slice(0, 8)

export const rowTooltip = (row: SessionRow): string =>
  [row.id, row.harness, rowNote(row)].filter((part) => part !== "").join(" · ")

export const rowTitle = (row: SessionRow): string => row.title || row.agent || shortId(row)

export const snapshotNote = (asOf: string): string => `Snapshot ${asOf} UTC, not a watch.`

const folderName = (root: string): string | undefined =>
  root
    .split("/")
    .filter((part) => part !== "")
    .at(-1)

export const projectHeading = (projectId: string, label: string): string => {
  const short = projectId.slice(0, 8)
  return label === short ? short : `${label} · ${short}`
}

export const groupSessions = (rows: readonly SessionRow[]): SessionGroup[] => {
  const order: string[] = []
  const grouped = new Map<string, SessionRow[]>()
  for (const row of rows) {
    const list = grouped.get(row.projectId)
    if (list === undefined) {
      order.push(row.projectId)
      grouped.set(row.projectId, [row])
    } else list.push(row)
  }
  return order.flatMap((projectId) => {
    const sessions = grouped.get(projectId)
    const first = sessions?.[0]
    if (sessions === undefined || first === undefined) return []
    const label = (first.repositoryRoot !== null && folderName(first.repositoryRoot)) || projectId.slice(0, 8)
    return [{ projectId, label, sessions }]
  })
}

export const requestPull = (pull: Pull): Pull => {
  if (pull.closed) return pull
  if (pull.running) return { ...pull, again: true }
  return { token: pull.token + 1, closed: false, running: true, again: false }
}

export const completePull = (pull: Pull, token: number): { readonly pull: Pull; readonly apply: boolean } => {
  if (pull.closed || token !== pull.token) return { pull, apply: false }
  if (pull.again) return { apply: false, pull: { token: pull.token + 1, closed: false, running: true, again: false } }
  return { apply: true, pull: { ...pull, running: false } }
}

export const closePull = (pull: Pull): Pull => ({
  token: pull.token + 1,
  closed: true,
  running: false,
  again: false,
})

export const sessionStatus = (row: SessionRow): string =>
  row.turnState === "" || row.turnState === "none" ? row.status : `${row.status}/${row.turnState}`
