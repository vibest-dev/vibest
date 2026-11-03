// One-time move of a version 1 vibest.db to version 2 (docs/design/schema.md, Moving from version 1). Stop vibestd,
// then: `bun apps/vibest-herdr/scripts/migrate-db-v2.ts ~/.vibest/vibest.db`. It copies the file to
// <file>.v1-backup-<time> first, builds version 2 from that copy into a new file, checks its foreign keys, and only
// then puts it in place of <file>. What version 2 does not store is dropped: stop records, the `--peer` link, the
// runtime's last status, a result's parsed details (derived from its text again), and every other metadata key.
import { Database } from "bun:sqlite"
import fs from "node:fs"

import { APPLICATION_ID, SCHEMA } from "@vibest/core/db"
import { isUsageLimitError } from "@vibest/core/results"

type V1Session = {
  readonly id: string
  readonly project_id: number
  readonly parent_session_id: string | null
  readonly agent_type: string
  readonly harness: string
  readonly directory: string
  readonly runtime: string | null
  readonly harness_session_id: string | null
  readonly metadata: string
  readonly created_at: number
  readonly ended_at: number | null
}
type V1Inbox = {
  readonly id: number
  readonly recipient_session_id: string
  readonly sender_type: string
  readonly sender_id: string | null
  readonly content: string
  readonly result_message_id: number | null
  readonly delivery_status: string
}
type V1Message = {
  readonly id: number
  readonly session_id: string
  readonly inbox_id: number | null
  readonly input: string
  readonly output: string | null
  readonly status: string
  readonly metadata: string
  readonly started_at: number
  readonly ended_at: number | null
}
type Event = {
  readonly id: number
  readonly at: number
  readonly session: string
  readonly type: string
  readonly process?: number | undefined
  readonly turn?: number | undefined
  readonly inbox?: number | undefined
  readonly data: Record<string, unknown>
}

const TURN_END = new Set(["completed", "failed", "interrupted", "lost", "not_started"])
const INBOX_STATUS = new Set(["pending", "delivering", "delivered", "failed", "dropped"])

const json = (raw: string | null): Record<string, unknown> => {
  try {
    const value: unknown = raw === null ? {} : JSON.parse(raw)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * The harness's answer in a v1 output: the body of its `<agent-result>`'s `<result>` without the `error:` line vibest
 * added (results.ts envelope); a v1 output that is not an envelope is the answer itself. v2 `turn.end.output` is the answer.
 */
const answerOf = (output: string, error: string | undefined) => {
  const body = /^<agent-result>\n[\s\S]*?<result>\n([\s\S]*)\n<\/result>\n<\/agent-result>$/.exec(output)?.[1]
  if (body === undefined) return output
  const suffix = error === undefined ? undefined : `error: ${error}`
  if (suffix === undefined || !body.endsWith(suffix)) return body
  return body.slice(0, -suffix.length).replace(/\n\n$/, "")
}

const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined)
const num = (value: unknown) => (typeof value === "number" ? value : undefined)

/**
 * A runtime from before the runtime port, `{type, session, pane?}`, as `{kind, machine, id}`; the id carries the agent
 * name those builds gave it (`s-<row id>`), so the runtime still finds a live agent by its own name. undefined when
 * the value is not one of those.
 */
export const preportRuntime = (raw: string, id: string): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const value = parsed as { readonly type?: unknown; readonly session?: unknown; readonly pane?: unknown }
  if (typeof value.type !== "string" || value.type === "" || typeof value.session !== "string") return undefined
  if (value.pane !== undefined && typeof value.pane !== "string") return undefined
  return JSON.stringify({
    kind: value.type,
    machine: "local",
    id: value.pane === undefined ? "" : `${value.session}/${value.pane}/s-${id}`,
  })
}

/** Version 2 rows for the version 1 database attached as `old`. */
const mapRows = (db: Database) => {
  const projects = db.query("SELECT id, directory, main_session_id FROM old.project ORDER BY id").all() as Array<{
    id: number
    directory: string
    main_session_id: string | null
  }>
  const sessions = db.query("SELECT * FROM old.session ORDER BY created_at, id").all() as Array<V1Session>
  const inbox = db.query("SELECT * FROM old.inbox ORDER BY id").all() as Array<V1Inbox>
  const messages = db.query("SELECT * FROM old.message ORDER BY id").all() as Array<V1Message>
  const known = new Set(sessions.map((s) => s.id))
  const mainOf = new Map(projects.map((p) => [p.id, p.main_session_id]))

  const events: Array<Event> = []
  const add = (event: Omit<Event, "id">) => {
    const id = events.length + 1
    events.push({ ...event, id })
    return id
  }
  /** The `turn.end` of each v1 message that ended, for the result rows that point at it. */
  const turnEnd = new Map<number, number>()
  /** Inbox rows a turn consumed: their delivered event is that turn's. */
  const consumed = new Set<number>()
  const taskOf = new Map<string, number>()
  const v2Sessions: Array<Record<string, unknown>> = []

  for (const s of sessions) {
    const meta = json(s.metadata)
    const main = s.agent_type === "main"
    const archived = meta.archived === true || meta.removed === true
    const runtime = json(s.runtime === null ? null : (preportRuntime(s.runtime, s.id) ?? s.runtime))
    const kind = str(runtime.kind) ?? ""
    const machine = str(runtime.machine) ?? "local"
    const terminal = str(runtime.id) ?? ""
    const startedAt = num(meta.startedAt)
    const exitedAt = main ? s.ended_at : (num(meta.exitedAt) ?? null)
    const lastActive = num(meta.lastActive) ?? s.created_at
    const task = num(meta.task)
    if (task !== undefined) taskOf.set(s.id, task)
    v2Sessions.push({
      id: s.id,
      project_id: s.project_id,
      parent_session_id: s.parent_session_id,
      report_to_session_id: s.parent_session_id ?? (main ? null : (mainOf.get(s.project_id) ?? null)),
      role: s.agent_type,
      name: str(meta.name) ?? (main ? "main" : ""),
      machine,
      directory: main ? (str(meta.projectDirectory) ?? "") : s.directory,
      archive_on_completion: meta.archive === true ? 1 : 0,
      created_at: s.created_at,
      ended_at: main ? s.ended_at : archived ? (s.ended_at ?? exitedAt ?? lastActive) : null,
    })

    // Usage-limit tries: each a process that ended `limited`.
    for (const attempt of Array.isArray(meta.attempts) ? (meta.attempts as Array<Record<string, unknown>>) : []) {
      const harness = str(attempt.harness)
      const at = num(attempt.at)
      if (harness === undefined || at === undefined) continue
      const provider = str(attempt.provider)
      const tried = add({
        at,
        session: s.id,
        type: "process.start",
        data: { harness, ...(provider ? { provider } : {}), runtime: kind, machine, terminal: "" },
      })
      add({ at, session: s.id, type: "process.end", process: tried, data: { reason: "limited" } })
    }

    // The process it has now (or last had).
    const provider = str(meta.provider)
    const model = str(meta.model)
    const routing = typeof meta.routing === "object" && meta.routing !== null ? meta.routing : undefined
    const placed = kind !== "" && terminal !== ""
    const processId = add({
      at: placed ? (startedAt ?? s.created_at) : s.created_at,
      session: s.id,
      type: "process.start",
      data: {
        harness: s.harness,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(routing === undefined ? {} : { routing }),
        runtime: kind,
        machine,
        terminal: placed ? terminal : "",
        ...(s.harness_session_id ? { resume: s.harness_session_id } : {}),
      },
    })
    const pid = num(meta.pid)
    const ready = num(meta.ready)
    const integration = typeof meta.integration === "object" && meta.integration !== null ? meta.integration : undefined
    if (ready !== undefined || pid !== undefined || integration !== undefined)
      add({
        at: ready ?? startedAt ?? s.created_at,
        session: s.id,
        type: "process.ready",
        process: processId,
        data: {
          ...(pid === undefined ? {} : { pid }),
          ...(ready === undefined ? { pidOnly: true } : {}),
          ...(integration === undefined ? {} : { integration }),
        },
      })

    // Its turns, each with the rows it consumed (v1: delivered rows after the previous turn's last, up to its own).
    let last = 0
    for (const m of messages.filter((row) => row.session_id === s.id)) {
      const typed = m.inbox_id === null && m.input !== ""
      const turn = add({
        at: m.started_at,
        session: s.id,
        type: "turn.start",
        process: processId,
        data: { by: typed ? "typed" : "delivery", ...(typed ? { typed: m.input } : {}) },
      })
      if (m.inbox_id !== null) {
        for (const row of inbox) {
          if (row.recipient_session_id !== s.id || row.id <= last || row.id > m.inbox_id) continue
          if (row.delivery_status !== "delivered" && row.delivery_status !== "delivering") continue
          consumed.add(row.id)
          add({
            at: m.started_at,
            session: s.id,
            type: "inbox.status",
            inbox: row.id,
            turn,
            data: { from: "pending", to: "delivered" },
          })
        }
        last = m.inbox_id
      }
      if (m.status === "working") continue
      const error = str(json(m.metadata).error)
      turnEnd.set(
        m.id,
        add({
          at: m.ended_at ?? m.started_at,
          session: s.id,
          type: "turn.end",
          process: processId,
          turn,
          data: {
            status: TURN_END.has(m.status) ? m.status : "lost",
            ...(m.output ? { output: answerOf(m.output, error) } : {}),
            ...(error === undefined
              ? {}
              : { failure: { kind: isUsageLimitError(error) ? "limited" : "other", message: error } }),
          },
        }),
      )
    }

    const end = placed ? exitedAt : (exitedAt ?? (main ? lastActive : null))
    if (end !== null || archived)
      add({
        at: end ?? s.ended_at ?? lastActive,
        session: s.id,
        type: "process.end",
        process: processId,
        data: { reason: archived || (main && s.ended_at !== null) ? "archived" : "exited" },
      })
  }

  // Inbox rows keep their ids; v1 `sender_type` and the result link become the kind.
  const v2Inbox: Array<Record<string, unknown>> = []
  for (const row of inbox) {
    const endId = row.result_message_id === null ? undefined : turnEnd.get(row.result_message_id)
    const kind =
      endId !== undefined
        ? "result"
        : row.sender_type === "user"
          ? taskOf.get(row.recipient_session_id) === row.id
            ? "task"
            : "send"
          : row.sender_type === "session"
            ? "report"
            : "notice"
    const status =
      row.delivery_status === "sending"
        ? "delivering"
        : INBOX_STATUS.has(row.delivery_status)
          ? row.delivery_status
          : "failed"
    const sender = row.sender_id !== null && known.has(row.sender_id) ? row.sender_id : null
    v2Inbox.push({
      id: row.id,
      recipient_session_id: row.recipient_session_id,
      kind,
      sender_session_id: sender,
      content: row.content,
      result_event_id: endId ?? null,
      status,
    })
    const at =
      endId !== undefined
        ? events[endId - 1]!.at
        : (sessions.find((s) => s.id === row.recipient_session_id)?.created_at ?? 0)
    add({ at, session: row.recipient_session_id, type: "inbox.queued", inbox: row.id, data: { kind } })
    // A delivered task no turn took yet: its first turn takes it (as vibestd's own linkTask does).
    if (status !== "pending" && !consumed.has(row.id) && !(kind === "task" && status === "delivered"))
      add({
        at,
        session: row.recipient_session_id,
        type: "inbox.status",
        inbox: row.id,
        data: { from: "pending", to: status },
      })
  }

  const v2Projects = projects.map((p) => ({
    id: p.id,
    key: p.directory,
    entry_session_id: p.main_session_id,
  }))
  return { projects: v2Projects, sessions: v2Sessions, inbox: v2Inbox, events }
}

const insertAll = (db: Database, table: string, rows: ReadonlyArray<Record<string, unknown>>) => {
  if (rows.length === 0) return
  const columns = Object.keys(rows[0]!)
  const statement = db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  )
  for (const row of rows) statement.run(...(columns.map((c) => row[c] ?? null) as Array<string | number | null>))
}

/** Migrate `file` from version 1 to version 2 in place; returns the backup it made first. */
export const migrateDbV2 = (file: string, now = Date.now()) => {
  if (!fs.existsSync(file)) throw new Error(`${file}: no such file`)
  const v1 = new Database(file)
  const header = (key: string) => (v1.query(`PRAGMA ${key}`).get() as Record<string, number>)[key] ?? 0
  const [applicationId, version] = [header("application_id"), header("user_version")]
  if (applicationId !== APPLICATION_ID || version !== 1) {
    v1.close()
    throw new Error(
      `${file} is not a version 1 vibest.db (application_id 0x${(applicationId >>> 0).toString(16)}, version ${version}); nothing changed`,
    )
  }
  const backup = `${file}.v1-backup-${now}`
  if (fs.existsSync(backup)) throw new Error(`${backup} already exists; nothing changed`)
  v1.run("VACUUM INTO ?", [backup])
  v1.close()

  const next = `${file}.v2-migrating`
  fs.rmSync(next, { force: true })
  const db = new Database(next)
  try {
    db.run("PRAGMA foreign_keys = OFF")
    for (const statement of SCHEMA) db.run(statement)
    db.run("ATTACH DATABASE ? AS old", [backup])
    const rows = mapRows(db)
    db.transaction(() => {
      insertAll(db, "project", rows.projects)
      insertAll(db, "session", rows.sessions)
      insertAll(db, "inbox", rows.inbox)
      insertAll(
        db,
        "event",
        rows.events.map((e) => ({
          id: e.id,
          at: e.at,
          session_id: e.session,
          type: e.type,
          process_id: e.process ?? null,
          turn_id: e.turn ?? null,
          inbox_id: e.inbox ?? null,
          data: JSON.stringify(e.data),
        })),
      )
    })()
    db.run("DETACH DATABASE old")
    const broken = db.query("PRAGMA foreign_key_check").all()
    if (broken.length > 0) throw new Error(`foreign keys do not hold: ${JSON.stringify(broken.slice(0, 5))}`)
    db.close()
  } catch (error) {
    db.close()
    fs.rmSync(next, { force: true })
    throw error
  }
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true })
  fs.renameSync(next, file)
  return { backup }
}

if (import.meta.main) {
  const [file] = process.argv.slice(2)
  if (file === undefined) {
    console.error("usage: bun apps/vibest-herdr/scripts/migrate-db-v2.ts <path to vibest.db>   (stop vibestd first)")
    process.exit(1)
  }
  try {
    const { backup } = migrateDbV2(file)
    console.log(`${file}: now version 2; the version 1 file is kept at ${backup}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
