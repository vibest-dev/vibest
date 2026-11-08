export const SESSION_LABEL = "vibest.session"

const STRIPPED = ["VIBEST_SESSION_ID", "VIBEST_AGENT", "VIBEST_PROJECT_ID"] as const

export const cliArgv = (command: "status" | "ls"): string[] => [
  ...STRIPPED.flatMap((name) => ["-u", name]),
  "vibest",
  command,
  ...(command === "ls" ? ["--no-start"] : []),
]

export interface SessionRow {
  readonly id: string
  readonly projectId: string
  readonly title: string
  readonly agent: string
  readonly harness: string
  readonly status: string
  readonly turnState: string
  readonly runtime: string
  readonly machine: string
  readonly addressId: string
  readonly socket: string
  readonly coreAddress: string
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

export type Placement =
  | { readonly action: "focus"; readonly terminal: string }
  | { readonly action: "none"; readonly reason: string }

export interface SessionGroup {
  readonly projectId: string
  readonly label: string
  readonly sessions: readonly SessionRow[]
}

export type StatusVerdict = { readonly list: false; readonly message: string } | { readonly list: true }

export interface Pull {
  readonly token: number
  readonly closed: boolean
  readonly running: boolean
  readonly again: boolean
}

export const idlePull = (): Pull => ({ token: 0, closed: false, running: false, again: false })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

export const parseOwnedAddress = (id: string): { readonly address: string; readonly socket: string } | undefined => {
  const at = id.indexOf("@")
  if (at <= 0 || at === id.length - 1) return undefined
  return { address: id.slice(0, at), socket: id.slice(at + 1) }
}

export const placeSession = (
  session: SessionRow,
  terminals: readonly CoreTerminal[],
  panes: readonly ModelPane[],
  windowSocket: string | undefined,
): Placement => {
  if (session.runtime !== "hc") return { action: "none", reason: `runtime ${session.runtime || "unknown"}` }
  if (session.machine !== "local") return { action: "none", reason: "on another machine" }
  if (session.socket === "" || session.coreAddress === "" || session.coreAddress.includes("/"))
    return { action: "none", reason: "no local terminal" }
  if (windowSocket === undefined || windowSocket === "") return { action: "none", reason: "core not proven" }
  if (windowSocket !== session.socket) return { action: "none", reason: "other core" }
  const matches = terminals.filter(
    (terminal) => terminal.address === session.coreAddress && terminal.labels[SESSION_LABEL] === session.id,
  )
  if (matches.length > 1) return { action: "none", reason: "ambiguous" }
  const found = matches[0]
  if (found === undefined) return { action: "none", reason: "not in this window" }
  if (!panes.some((pane) => pane.terminal === found.address)) return { action: "none", reason: "no pane to focus" }
  return { action: "focus", terminal: found.address }
}

export const focusAtClick = (
  session: SessionRow,
  terminalsNow: unknown,
  panesNow: unknown,
  windowSocket: string | undefined,
): { readonly command: "pane.focus"; readonly args: { readonly terminal: string } } | undefined => {
  const place = placeSession(session, coreTerminals(terminalsNow), modelPanes(panesNow), windowSocket)
  if (place.action !== "focus") return undefined
  return { command: "pane.focus", args: { terminal: place.terminal } }
}

export const commandNote = (
  result: { readonly code: number; readonly stdout: string; readonly stderr: string },
  fallback: string,
): string => {
  if (result.code === 0) return ""
  const trimmed = (result.stderr || result.stdout).trim()
  return (trimmed === "" ? fallback : trimmed).slice(0, 180)
}

export const settleList = (result: {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}): { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly note: string } =>
  result.code === 0 ? { ok: true, stdout: result.stdout } : { ok: false, note: commandNote(result, "vibest ls failed") }

export const statusVerdict = (stdout: string): StatusVerdict | undefined => {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!isRecord(value) || !isRecord(value.daemon)) return undefined
  const status = text(value.daemon.status)
  if (status === undefined) return undefined
  if (status !== "running") return { list: false, message: "vibestd is not running" }
  const client = isRecord(value.client) ? value.client : undefined
  const clientVersion = client ? text(client.version) : undefined
  const daemonVersion = text(value.daemon.version)
  if (value.daemon.sameVersion !== true)
    return {
      list: false,
      message: `vibestd ${daemonVersion ?? "unknown"} is not this vibest ${clientVersion ?? "unknown"}`,
    }
  if (typeof value.daemon.protocol !== "number") return { list: false, message: "vibest status has no protocol" }
  return { list: true }
}

const sessionRow = (item: Record<string, unknown>): SessionRow | undefined => {
  const id = text(item.id)
  const projectId = text(item.projectId)
  const address = isRecord(item.address) ? item.address : undefined
  const addressId = address ? text(address.id) : undefined
  const machine = address ? text(address.machine) : undefined
  if (id === undefined || projectId === undefined || addressId === undefined || machine === undefined) return undefined
  const owned = parseOwnedAddress(addressId)
  return {
    id,
    projectId,
    title: text(item.title) ?? text(item.name) ?? "",
    agent: text(item.agent) ?? "",
    harness: text(item.harness) ?? "",
    status: text(item.status) ?? "unknown",
    turnState: text(item.turnState) ?? "",
    runtime: text(item.runtime) ?? "",
    machine,
    addressId,
    socket: owned?.socket ?? "",
    coreAddress: owned?.address ?? "",
    repositoryRoot: item.repositoryRoot === null ? null : (text(item.repositoryRoot) ?? null),
  }
}

export const parseSessions = (stdout: string): readonly SessionRow[] | undefined => {
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

export const rowTitle = (row: SessionRow): string => row.title || row.agent || row.id.slice(0, 8)

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
