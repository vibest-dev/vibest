const STRIPPED = ["VIBEST_SESSION_ID", "VIBEST_AGENT", "VIBEST_PROJECT_ID"] as const

export const LS_ARGV: readonly string[] = [
  ...STRIPPED.flatMap((name) => ["-u", name]),
  "vibest",
  "ls",
  "--all-projects",
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

export const commandNote = (
  result: { readonly code: number; readonly stdout: string; readonly stderr: string },
  fallback: string,
): string => {
  if (result.code === 0) return ""
  const trimmed = (result.stderr || result.stdout).trim()
  return (trimmed === "" ? fallback : trimmed).slice(0, 180)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

export const parseOwnedAddress = (id: string): { readonly address: string; readonly socket: string } | undefined => {
  const at = id.indexOf("@")
  if (at <= 0 || at === id.length - 1) return undefined
  return { address: id.slice(0, at), socket: id.slice(at + 1) }
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
