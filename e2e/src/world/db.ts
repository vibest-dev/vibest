import { Database } from "bun:sqlite"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import path from "node:path"

import { Predicate, type Schema } from "effect"

export interface TerminalJson {
  readonly session?: string
  readonly pane?: string
  readonly address?: string
  readonly socket?: string
  readonly block?: string
  readonly id?: string
  readonly name?: string
}

export const readDb = (file: string) => {
  const db = new Database(file, { readonly: true })
  db.run("PRAGMA busy_timeout = 5000")

  return db
}

export const parseTerminalJson = (terminal: string | null | undefined): TerminalJson | undefined => {
  if (!terminal || !terminal.startsWith("{")) return undefined

  try {
    const parsed = JSON.parse(terminal) as Schema.Json

    return Predicate.isObject(parsed) && !Array.isArray(parsed) ? (parsed as TerminalJson) : undefined
  } catch {
    return undefined
  }
}

export const herdrPane = (terminal: string | null | undefined) => {
  if (!terminal) return undefined
  const parsed = parseTerminalJson(terminal)

  return parsed !== undefined ? parsed.pane : terminal.split("/")[1]
}

export const entrySessionId = async (cwd: string, home: string): Promise<string | undefined> => {
  const file = path.join(home, "vibest.db")

  if (!fs.existsSync(file)) return undefined
  const directory = await fsPromises.realpath(cwd)
  const db = readDb(file)

  try {
    const cols = new Set(
      (db.query("SELECT name FROM pragma_table_info('session')").all() as Array<{ name: string }>).map((c) => c.name),
    )

    const origin = cols.has("origin_remote")
      ? "AND s.origin_remote IS NULL"
      : cols.has("origin_peer")
        ? "AND s.origin_peer IS NULL"
        : ""

    const found = db
      .query(
        `SELECT s.id FROM project p JOIN session s ON s.project_id = p.id
          WHERE p.directory = ? AND s.parent_session_id IS NULL ${origin} AND s.ended_at IS NULL
          ORDER BY coalesce(s.active_at, s.created_at) DESC, s.rowid DESC LIMIT 1`,
      )
      .get(directory) as { id: string } | null

    return found?.id
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

export const foreignTerminalsIn = (
  home: string,
  root: string,
  herdrSession: string,
  ownRuntimes: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const file = path.join(home, "vibest.db")

  if (!fs.existsSync(file)) return []
  const db = readDb(file)

  try {
    const rows = db
      .query(
        `SELECT s.id, p.runtime, p.terminal
         FROM session s
         LEFT JOIN process p ON p.session_id = s.id AND p.id = (SELECT max(id) FROM process WHERE session_id = s.id)`,
      )
      .all() as Array<{
      id: string
      runtime: string | null
      terminal: string | null
    }>

    return rows.flatMap((r) => {
      if (r.runtime === null || r.terminal === null || r.terminal === "" || ownRuntimes.has(r.runtime)) return []
      const parsed = parseTerminalJson(r.terminal)

      if (r.runtime === "hc") {
        const own =
          parsed !== undefined
            ? parsed.socket === undefined || parsed.socket.startsWith(`${root}/`)
            : r.terminal.includes(`@${root}/`)

        return own ? [] : [`${r.id} at ${r.terminal}`]
      }

      const session =
        parsed !== undefined ? (parsed.session ?? parsed.id?.split("/")[0] ?? "") : (r.terminal.split("/")[0] ?? "")

      return session === "" || session === herdrSession || session.startsWith(`${herdrSession}-`)
        ? []
        : [`${r.id} at ${r.terminal}`]
    })
  } finally {
    db.close()
  }
}

const TERMINAL_ID_SQL = `CASE
  WHEN p.terminal IS NULL THEN ''
  WHEN NOT json_valid(p.terminal) THEN p.terminal
  WHEN p.runtime = 'hc' THEN CASE
    WHEN p.terminal ->> '$.socket' IS NOT NULL THEN (p.terminal ->> '$.address') || '@' || (p.terminal ->> '$.socket')
    ELSE coalesce(p.terminal ->> '$.address', p.terminal ->> '$.id', '')
  END
  WHEN p.runtime = 'herdr' THEN CASE
    WHEN p.terminal ->> '$.session' IS NOT NULL AND p.terminal ->> '$.pane' IS NOT NULL THEN
      (p.terminal ->> '$.session') || '/' || (p.terminal ->> '$.pane') || coalesce('/' || (p.terminal ->> '$.name'), '')
    ELSE coalesce(p.terminal ->> '$.id', '')
  END
  WHEN p.runtime = 'rex' THEN CASE
    WHEN p.terminal ->> '$.session' IS NOT NULL AND p.terminal ->> '$.block' IS NOT NULL THEN
      (p.terminal ->> '$.session') || '/' || (p.terminal ->> '$.block')
    ELSE coalesce(p.terminal ->> '$.id', '')
  END
  ELSE coalesce(p.terminal ->> '$.id', p.terminal)
END`

export const SESSIONS = `(SELECT s.id, s.project_id, s.parent_session_id, s.agent AS agent_type, s.directory, s.created_at, s.ended_at,
    p.harness, p.provider,
    CASE WHEN p.id IS NULL THEN NULL ELSE json_object('kind', p.runtime, 'id', ${TERMINAL_ID_SQL}) END AS runtime,
    p.harness_session_id, p.pid, p.integration_version AS version,
    p.ended_at AS exited_at
  FROM session s LEFT JOIN process p ON p.session_id = s.id AND p.id = (SELECT max(id) FROM process WHERE session_id = s.id))`

export const EXECUTIONS = `(SELECT id, session_id, coalesce(outcome, 'working') AS status FROM execution)`

const READ_MODEL = ["session", "process", "execution", "inbox"] as const

export const ledgerSnapshot = (home: string) => {
  const file = path.join(home, "vibest.db")

  if (!fs.existsSync(file)) return undefined
  const db = readDb(file)

  try {
    const facts = (
      db.query("SELECT aggregate, seq, at, type, data FROM event ORDER BY position").all() as Array<{
        data: string
      }>
    ).map((fact) => ({ ...fact, data: JSON.parse(fact.data) as unknown }))

    return {
      facts,
      ...Object.fromEntries(
        READ_MODEL.map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
      ),
    }
  } finally {
    db.close()
  }
}
