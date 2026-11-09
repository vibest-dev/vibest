import type { SessionRow } from "./ls.ts"

export interface SessionGroup {
  readonly projectId: string
  readonly label: string
  readonly sessions: readonly SessionRow[]
}

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

export const sessionStatus = (row: SessionRow): string =>
  row.turnState === "" || row.turnState === "none" ? row.status : `${row.status}/${row.turnState}`
