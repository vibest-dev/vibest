const STRIPPED = ["VIBEST_SESSION_ID", "VIBEST_AGENT", "VIBEST_PROJECT_ID"] as const

export const LS_ARGV: readonly string[] = [...STRIPPED.flatMap((name) => ["-u", name]), "vibest", "ls"]

export interface SessionRow {
  readonly id: string
  readonly projectId: string
  readonly title: string
  readonly agent: string
  readonly harness: string
  readonly status: string
  readonly executionState: string
  readonly branch: string
  readonly runtime: string
  readonly machine: string
  readonly addressId: string
  readonly socket: string
  readonly coreAddress: string
  readonly repositoryRoot: string | null
}

type JsonPrimitive = string | number | boolean | null | undefined

type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject

interface JsonObject {
  readonly [key: string]: JsonValue
}

export const commandNote = (
  result: { readonly code: number; readonly stdout: string; readonly stderr: string },
  fallback: string,
): string => {
  if (result.code === 0) return ""

  const trimmed = (result.stderr || result.stdout).trim()

  return (trimmed === "" ? fallback : trimmed).slice(0, 180)
}

const tag = (value: JsonValue): string => Object.prototype.toString.call(value)

const isObject = (value: JsonValue): value is JsonObject => tag(value) === "[object Object]"

const text = (value: JsonValue): string | undefined => (tag(value) === "[object String]" ? String(value) : undefined)

export const parseOwnedAddress = (id: string): { readonly address: string; readonly socket: string } | undefined => {
  const at = id.indexOf("@")

  if (at <= 0 || at === id.length - 1) return undefined

  return { address: id.slice(0, at), socket: id.slice(at + 1) }
}

const sessionRow = (item: JsonObject): SessionRow | undefined => {
  const id = text(item.id)
  const projectId = text(item.projectId)
  const address = isObject(item.address) ? item.address : undefined
  const addressId = address ? text(address.id) : undefined
  const machine = address ? text(address.machine) : undefined

  if (id === undefined || projectId === undefined || addressId === undefined || machine === undefined) return undefined

  const owned = parseOwnedAddress(addressId)
  const git = isObject(item.git) ? item.git : undefined

  return {
    id,
    projectId,
    title: text(item.title) ?? text(item.name) ?? "",
    agent: text(item.agent) ?? "",
    harness: text(item.harness) ?? "",
    status: text(item.status) ?? "unknown",
    executionState: text(item.executionState) ?? "",
    branch: git ? (text(git.branch) ?? "") : "",
    runtime: text(item.runtime) ?? "",
    machine,
    addressId,
    socket: owned?.socket ?? "",
    coreAddress: owned?.address ?? "",
    repositoryRoot: item.repositoryRoot === null ? null : (text(item.repositoryRoot) ?? null),
  }
}

const sessionItems = (value: JsonValue): readonly JsonValue[] | undefined => {
  if (isObject(value) && Array.isArray(value.sessions)) return value.sessions

  return undefined
}

export const parseSessions = (stdout: string): readonly SessionRow[] | undefined => {
  let value: JsonValue

  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }

  const items = sessionItems(value)

  if (items === undefined) return undefined

  const rows: SessionRow[] = []

  for (const item of items) {
    if (!isObject(item)) return undefined

    const row = sessionRow(item)

    if (row === undefined) return undefined

    rows.push(row)
  }

  return rows
}

export interface LsResult {
  readonly sessions: readonly SessionRow[]
  readonly note: string
  readonly asOf: string
}

export const readLsResult = (
  result: { readonly code: number; readonly stdout: string; readonly stderr: string },
  now: Date,
): LsResult => {
  if (result.code !== 0) return { sessions: [], note: commandNote(result, "vibest ls failed"), asOf: "" }

  const sessions = parseSessions(result.stdout)

  if (sessions === undefined) return { sessions: [], note: "vibest ls was not understood", asOf: "" }

  return {
    sessions,
    note: sessions.length === 0 ? "No live sessions." : "",
    asOf: now.toISOString().slice(11, 19),
  }
}

export const lsFailure = (error: Error | string): LsResult => ({
  sessions: [],
  note: commandNote(
    { code: 1, stdout: "", stderr: error instanceof Error ? error.message : error },
    "vibest could not be run",
  ),
  asOf: "",
})
