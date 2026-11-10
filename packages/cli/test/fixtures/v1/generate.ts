import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Bus } from "@vibest/core/bus"
import { Db, type SessionRow } from "@vibest/core/db"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

const here = import.meta.dirname
const RUNTIME = "herdr"
const MAIN_PLACE = { runtime: RUNTIME, address: { machine: "local", id: "w1:p1" } }
const PEER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const MACHINE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const ORIGIN_PROJECT = "22222222-2222-4222-8222-222222222222"
const ORIGIN_MAIN = "33333333-3333-4333-8333-333333333333"

const row = (id: string, patch: Partial<Omit<SessionRow, "projectId">> = {}): Omit<SessionRow, "projectId"> => ({
  id,
  agent: "general",
  name: "tests",
  harnessId: "pi",
  provider: null,
  model: null,
  harnessSessionId: null,
  runtime: RUNTIME,
  address: { machine: "local", id: "" },
  status: "unknown",
  startedAt: null,
  exitedAt: null,
  turnState: "none",
  turnPromptedAt: 0,
  metadata: {},
  createdAt: Date.now(),
  lastActive: Date.now(),
  ...patch,
})

const spawned = (project: string, name: string, task: string, request?: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const id = yield* db.newSessionId
    const main = (yield* db.coordinatorOf(project))?.id
    yield* db.insertSession(row(id, { name }), project, {
      task,
      cwd: `/w/${name}`,
      ...(main === undefined ? {} : { parentSessionId: main }),
      ...(request === undefined ? {} : { request }),
    })
    return id
  })

const placed = (id: string, terminal: string, pid: number) =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db.updateSession(id, { address: { machine: "local", id: terminal }, startedAt: Date.now() })
    yield* db.patchLive(id, { pid, ready: Date.now() })
  })

const takenTurn = (id: string, text: string, status: "completed" | "failed" = "completed") =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db.updateSession(id, { turnState: "open", turnPromptedAt: Date.now() })
    yield* db.linkTask(id)
    yield* db.reportTurn(id, {
      harness: "pi",
      at: Date.now(),
      text,
      error: status === "failed" ? "model overloaded" : undefined,
      conversationId: `conv-${id.slice(0, 8)}`,
      interrupted: false,
    })
    const report = yield* db.latestReport(id, "start")
    return yield* db.finishTurn(
      id,
      {
        status,
        ...(report === undefined ? {} : { report: report.id }),
        ...(status === "failed" ? { failure: { message: "model overloaded" } } : {}),
      },
      { status: "idle" },
      { sessionId: id, kind: "result", message: `<summary>${text}</summary>`, details: {} },
    )
  })

const sessionsScenario = Effect.gen(function* () {
  const db = yield* Db
  const project = yield* db.createProject("/w/app", [{ path: "/w/app", remote: "git@example.com:acme/app.git" }])
  const main = yield* db.coordinatorLaunch(project, "claude", false, MAIN_PLACE, {
    projectDirectory: "/w/app",
    pid: 4000,
  })
  yield* db.reportCoordinatorSession(main.sessionId, "claude", "main-conversation")

  const fixer = yield* spawned(project, "fixer", "fix the flaky test", "req-fixer")
  yield* placed(fixer, "w1:p2", 4100)
  const result = yield* takenTurn(fixer, "All tests pass.")
  yield* db.claim([result.id], {
    projectId: project,
    runtime: RUNTIME,
    address: JSON.stringify(MAIN_PLACE.address),
  })
  yield* db.settleLeased(project, [result.id], [])

  const failing = yield* spawned(project, "failing", "never starts")
  yield* db.updateSession(failing, { exitedAt: Date.now(), end: "launch_failed", turnState: "failed" })

  const restarted = yield* spawned(project, "restarted", "restart me")
  yield* placed(restarted, "w1:p3", 4200)
  yield* db.restartProcess(restarted)
  yield* db.updateSession(restarted, { address: { machine: "local", id: "w1:p3" }, startedAt: Date.now() })
  yield* db.patchLive(restarted, { pid: 4201, ready: Date.now() })
  yield* db.patchLive(restarted, { pid: 4202 })

  const moved = yield* spawned(project, "moved", "move on limit")
  yield* placed(moved, "w1:p4", 4300)
  yield* db.updateSession(moved, { exitedAt: Date.now(), end: "limited" })
  yield* db.updateSession(moved, { harnessId: "claude", address: { machine: "local", id: "" } })
  yield* placed(moved, "w1:p5", 4301)
  yield* takenTurn(moved, "Moved and done.", "failed")

  const typed = yield* spawned(project, "typed", "wait for input")
  yield* placed(typed, "w1:p6", 4400)
  yield* db.beginUserTurn(typed, "please also update the docs", { turnPromptedAt: Date.now() })
  yield* db.reportTurn(typed, {
    harness: "pi",
    at: Date.now(),
    text: "Docs updated.",
    error: undefined,
    conversationId: undefined,
    interrupted: false,
  })

  const archived = yield* spawned(project, "archived", "archive me")
  yield* placed(archived, "w1:p7", 4500)
  yield* takenTurn(archived, "Done, archive me.")
  const s = yield* db.getSession(archived)
  yield* db.updateSession(archived, {
    metadata: { ...s!.metadata, archived: true, removed: true },
    exitedAt: Date.now(),
    end: "archived",
  })

  yield* db.insertSend(fixer, "one more thing", "send-1")
  const sent = yield* db.pendingInbox(fixer)
  yield* db.claim(sent.map((r) => r.id))

  const polled = yield* spawned(project, "polled", "report while polled")
  yield* placed(polled, "w1:p8", 4600)
  const leased = yield* takenTurn(polled, "Polled result.")
  yield* db.claim([leased.id])
  yield* db.recoverDelivering(["claude"], () => "")

  yield* db.coordinatorLaunch(project, "claude", true, MAIN_PLACE, { projectDirectory: "/w/app" })
  const orphan = yield* spawned(project, "orphan", "finish while the main agent is away")
  yield* placed(orphan, "w1:p9", 4700)
  yield* db.clearCoordinator(RUNTIME, MAIN_PLACE.address)
  yield* takenTurn(orphan, "Nobody listens.")

  yield* db.moveProject(project, "/src/app", [{ path: "/src/app", remote: "git@example.com:acme/app.git" }])
})

const machinesScenario = Effect.gen(function* () {
  const db = yield* Db
  yield* db.addMachine({ name: "mb", target: "root@mb.example", vibestdId: MACHINE })
  yield* db.machineConnected("mb")
  yield* db.notePeer({ id: PEER, name: "mac", callsMe: "mb" })
  const project = yield* db.createProject("/srv/app", [])
  const main = yield* db.coordinatorLaunch(project, "pi", false, MAIN_PLACE, { projectDirectory: "/srv/app" })

  const remote = yield* db.newSessionId
  yield* db.insertSession(row(remote, { name: "remote" }), project, {
    task: "run the remote tests",
    cwd: "/srv/app",
    request: "peer-spawn-1",
    origin: { peer: PEER, project: ORIGIN_PROJECT, parent: ORIGIN_MAIN, reportTo: ORIGIN_MAIN },
  })
  yield* placed(remote, "w2:p1", 5100)
  yield* takenTurn(remote, "Remote tests pass.")

  yield* db.receivePeerItem({ id: "7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f", recipient: main.sessionId, content: "done" })
  yield* db.receivePeerItem({ id: "7c1e2d3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f", recipient: main.sessionId, content: "done" })
})

const handwrittenScenario = Effect.gen(function* () {
  const db = yield* Db
  const sql = yield* SqlClient.SqlClient
  const project = yield* db.createProject("/w/old", [])
  const main = yield* db.coordinatorLaunch(project, "pi", false, MAIN_PLACE, { projectDirectory: "/w/old" })
  const old = yield* spawned(project, "old", "an old result with output")
  yield* placed(old, "w3:p1", 6100)
  yield* db.patchLive(old, { pid: 6101 })
  const [process] = yield* sql<{ id: number }>`SELECT max(id) AS id FROM event
    WHERE session_id = ${old} AND type = 'process.start'`
  const at = Date.now()
  const [turn] = yield* sql<{ id: number }>`INSERT INTO event (at, session_id, type, process_id, data)
    VALUES (${at}, ${old}, 'turn.start', ${process!.id}, '{"by":"delivery"}') RETURNING id`
  const [end] = yield* sql<{ id: number }>`INSERT INTO event (at, session_id, type, process_id, turn_id, data)
    VALUES (${at + 1}, ${old}, 'turn.end', ${process!.id}, ${turn!.id},
      '{"status":"completed","output":"Old output.\\nsecond line"}') RETURNING id`
  const [result] = yield* sql<{ id: number }>`INSERT INTO inbox (recipient_session_id, kind, sender_session_id, content,
      result_event_id, status) VALUES (${main.sessionId}, 'result', ${old}, 'old result', ${end!.id}, 'pending')
    RETURNING id`
  yield* sql`INSERT INTO event (at, session_id, type, inbox_id, data)
    VALUES (${at + 2}, ${main.sessionId}, 'inbox.queued', ${result!.id}, '{}')`
  for (const offset of [3, 4]) {
    const [notice] = yield* sql<{ id: number }>`INSERT INTO inbox (recipient_session_id, kind, content, status)
      VALUES (${main.sessionId}, 'notice', 'twice', 'pending') RETURNING id`
    yield* sql`INSERT INTO event (at, session_id, type, inbox_id, data)
      VALUES (${at + offset}, ${main.sessionId}, 'inbox.queued', ${notice!.id},
        '{"request":"peer:5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e"}')`
  }
})

const refereeFailsScenario = Effect.gen(function* () {
  const db = yield* Db
  const project = yield* db.createProject("/w/corner", [])
  yield* db.coordinatorLaunch(project, "pi", false, MAIN_PLACE, { projectDirectory: "/w/corner" })
  const corner = yield* spawned(project, "corner", "rechosen before it opened")
  yield* db.updateSession(corner, { harnessId: "claude" })
  yield* db.updateSession(corner, { exitedAt: Date.now(), end: "launch_failed" })
})

const dump = (file: string) => {
  const db = new Database(file, { readonly: true })
  const lines: Array<string> = []
  const [{ application_id }] = db.query("PRAGMA application_id").all() as [{ application_id: number }]
  const [{ user_version }] = db.query("PRAGMA user_version").all() as [{ user_version: number }]
  lines.push(`PRAGMA application_id = ${application_id};`, `PRAGMA user_version = ${user_version};`)
  const objects = db
    .query("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type != 'table', rowid")
    .all() as Array<{ type: string; name: string; sql: string }>
  const tables = objects.filter((o) => o.type === "table")
  for (const table of tables) lines.push(`${table.sql};`)
  for (const table of tables) {
    const columns = (db.query(`PRAGMA table_info("${table.name}")`).all() as Array<{ name: string }>).map((c) => c.name)
    const select = `SELECT 'INSERT INTO "${table.name}" VALUES (' || ${columns
      .map((c) => `quote("${c}")`)
      .join(" || ', ' || ")} || ');' AS line FROM "${table.name}" ORDER BY rowid`
    for (const { line } of db.query(select).all() as Array<{ line: string }>) lines.push(line)
  }
  for (const object of objects.filter((o) => o.type !== "table")) lines.push(`${object.sql};`)
  db.close()
  return `${lines.join("\n")}\n`
}

const generate = (name: string, scenario: Effect.Effect<unknown, unknown, Db | SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "vibest-v1-")))
    const file = path.join(directory, "vibest.db")
    yield* scenario.pipe(
      Effect.provide(Db.layer.pipe(Layer.provideMerge(Platform.sqlite(file)), Layer.provide(Bus.layer))),
      Effect.scoped,
    )
    yield* Effect.promise(() => fs.writeFile(path.join(here, `${name}.sql`), dump(file)))
    yield* Effect.promise(() => fs.rm(directory, { recursive: true }))
  })

await Effect.runPromise(
  Effect.gen(function* () {
    yield* generate("sessions", sessionsScenario)
    yield* generate("machines", machinesScenario)
    yield* generate("handwritten", handwrittenScenario)
    yield* generate("referee-fails", refereeFailsScenario)
  }),
)
