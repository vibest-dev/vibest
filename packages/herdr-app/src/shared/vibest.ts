const STRIPPED = ["VIBEST_SESSION_ID", "VIBEST_AGENT", "VIBEST_PROJECT_ID"] as const

export const cliArgv = (command: "status" | "ls"): string[] => [
  ...STRIPPED.flatMap((name) => ["-u", name]),
  ...(command === "status" ? ["VIBEST_NO_UPDATE_CHECK=1"] : []),
  "vibest",
  command,
  ...(command === "ls" ? ["--no-start", "--all-projects"] : []),
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

export type StatusVerdict = { readonly list: false; readonly message: string } | { readonly list: true }

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

export const parseOwnedAddress = (id: string): { readonly address: string; readonly socket: string } | undefined => {
  const at = id.indexOf("@")
  if (at <= 0 || at === id.length - 1) return undefined
  return { address: id.slice(0, at), socket: id.slice(at + 1) }
}

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
