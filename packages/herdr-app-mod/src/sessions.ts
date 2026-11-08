export const REFRESH_MS = 5000

export const SESSION_LABEL = "vibest.session"

const STRIPPED = ["VIBEST_SESSION_ID", "VIBEST_AGENT", "VIBEST_PROJECT_ID"] as const

export const cliArgv = (command: "status" | "ls"): string[] => [
  ...STRIPPED.flatMap((name) => ["-u", name]),
  "vibest",
  command,
]

export interface SessionRow {
  readonly id: string
  readonly projectId: string
  readonly name: string
  readonly agent: string
  readonly harness: string
  readonly status: string
  readonly turnState: string
  readonly runtime: string
  readonly addressId: string
  readonly repositoryRoot: string | null
}

export interface CoreTerminal {
  readonly address: string
  readonly labels: Readonly<Record<string, string>>
}

export interface ModelPane {
  readonly pane: string
  readonly terminal: string | null
}

export type Focus =
  | { readonly command: "pane.focus"; readonly args: { readonly terminal: string } }
  | { readonly command: "terminal.keep"; readonly args: { readonly terminal: string } }

export interface SessionGroup {
  readonly projectId: string
  readonly label: string
  readonly sessions: readonly SessionRow[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

export const coreAddress = (addressId: string): string => {
  const at = addressId.lastIndexOf("@")
  return at < 0 ? addressId : addressId.slice(0, at)
}

export const matchTerminal = (session: SessionRow, terminals: readonly CoreTerminal[]): CoreTerminal | undefined => {
  const want = coreAddress(session.addressId)
  if (want === "") return undefined
  const at = terminals.find((terminal) => terminal.address === want)
  if (at === undefined) return undefined
  const label = at.labels[SESSION_LABEL]
  if (label !== undefined && label !== "" && label !== session.id) return undefined
  return at
}

export const focusOf = (terminal: string, panes: readonly ModelPane[]): Focus =>
  panes.some((pane) => pane.terminal === terminal)
    ? { command: "pane.focus", args: { terminal } }
    : { command: "terminal.keep", args: { terminal } }

export const parseDaemonRunning = (stdout: string): boolean | undefined => {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!isRecord(value) || !isRecord(value.daemon)) return undefined
  const status = text(value.daemon.status)
  if (status === undefined) return undefined
  return status === "running"
}

const sessionRow = (item: Record<string, unknown>): SessionRow | undefined => {
  const id = text(item.id)
  const projectId = text(item.projectId)
  const address = isRecord(item.address) ? text(item.address.id) : undefined
  if (id === undefined || projectId === undefined || address === undefined) return undefined
  return {
    id,
    projectId,
    name: text(item.name) ?? "",
    agent: text(item.agent) ?? "",
    harness: text(item.harness) ?? "",
    status: text(item.status) ?? "unknown",
    turnState: text(item.turnState) ?? "",
    runtime: text(item.runtime) ?? "",
    addressId: address,
    repositoryRoot: item.repositoryRoot === null ? null : (text(item.repositoryRoot) ?? null),
  }
}

export const parseSessions = (stdout: string): SessionRow[] | undefined => {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(value)) return undefined
  const rows: SessionRow[] = []
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const row = sessionRow(item)
    if (row === undefined) return undefined
    rows.push(row)
  }
  return rows
}

export const coreTerminals = (value: unknown): CoreTerminal[] => {
  if (!Array.isArray(value)) return []
  const terminals: CoreTerminal[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.address !== "string") continue
    const labels: Record<string, string> = {}
    if (isRecord(item.labels)) {
      for (const [key, label] of Object.entries(item.labels)) if (typeof label === "string") labels[key] = label
    }
    terminals.push({ address: item.address, labels })
  }
  return terminals
}

export const modelPanes = (value: unknown): ModelPane[] => {
  if (!Array.isArray(value)) return []
  const panes: ModelPane[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.pane !== "string") continue
    panes.push({ pane: item.pane, terminal: typeof item.terminal === "string" ? item.terminal : null })
  }
  return panes
}

export const statusText = (row: SessionRow): string =>
  row.turnState === "" || row.turnState === "none" ? row.status : `${row.status}/${row.turnState}`

export const rowTitle = (row: SessionRow): string => row.name || row.agent || row.id.slice(0, 8)

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
