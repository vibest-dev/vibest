import fs from "node:fs/promises"
import path from "node:path"

import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Bus } from "@vibest/core/bus"
import { Db, SQL_NAMES } from "@vibest/core/db"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

const checkout = path.resolve(import.meta.dirname, "../../..")
const binary = path.join(checkout, "packages/cli/dist/vibest")
const target = 100_000
const sessions = 1000
const LIMIT_MS = 30_000
const RUNTIME = "bench"

const envFor = (home: string) => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("VIBEST_") || key.startsWith("HERDR_")) continue
    env[key] = value
  }
  env.VIBEST_HOME = home
  return env
}

const row = (id: string, i: number, now: number) => ({
  id,
  agent: "general",
  name: `n${i}`,
  harnessId: "pi",
  provider: null,
  model: null,
  harnessSessionId: null,
  runtime: RUNTIME,
  address: { machine: "local", id: "" },
  status: "unknown" as const,
  startedAt: null,
  exitedAt: null,
  turnState: "none" as const,
  turnPromptedAt: 0,
  metadata: {},
  createdAt: now,
  lastActive: now,
})

const turn = (id: string, text: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    yield* db.updateSession(id, { turnState: "open", turnPromptedAt: Date.now() })
    yield* db.linkTask(id)
    yield* db.reportTurn(id, {
      harness: "pi",
      at: Date.now(),
      text,
      error: undefined,
      conversationId: `conv-${id.slice(0, 8)}`,
      interrupted: false,
    })
    const report = yield* db.latestReport(id, "start")
    yield* db.finishTurn(
      id,
      { status: "completed", ...(report === undefined ? {} : { report: report.id }) },
      { status: "idle" },
      { sessionId: id, kind: "result", message: `<summary>${text}</summary>`, details: {} },
    )
  })

const seed = (file: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const sql = yield* SqlClient.SqlClient
    const project = yield* db.createProject("/w/bench", [])
    yield* db.coordinatorLaunch(
      project,
      "claude",
      false,
      { runtime: RUNTIME, address: { machine: "local", id: "main" } },
      { projectDirectory: "/w/bench" },
    )
    const ids: Array<string> = []
    for (let i = 0; i < sessions; i++) {
      const id = yield* db.newSessionId
      yield* db.insertSession(row(id, i, Date.now()), project, { task: `task ${i}`, cwd: "/w/bench" })
      yield* db.updateSession(id, { address: { machine: "local", id: `t${i}` }, startedAt: Date.now() })
      yield* db.patchLive(id, { pid: 10_000 + i, ready: Date.now() })
      ids.push(id)
    }
    for (let round = 0; ; round++) {
      const [{ n }] = (yield* sql<{ n: number }>`SELECT count(*) AS n FROM event`) as [{ n: number }]
      if (n >= target) return n
      for (const id of ids) yield* turn(id, `round ${round} of ${id.slice(0, 8)}: ${"done. ".repeat(20)}`)
    }
  }).pipe(
    Effect.provide(
      Db.layer.pipe(
        Layer.provideMerge(SqliteClient.layer({ filename: file, disableWAL: true, ...SQL_NAMES })),
        Layer.provide(Bus.layer),
      ),
    ),
    Effect.scoped,
  )

if (!(await Bun.file(binary).exists())) {
  console.error(`no ${binary}; run pnpm build first`)
  process.exit(1)
}
const root = await fs.realpath(await fs.mkdtemp(path.join("/tmp", "vbi-")))
const home = path.join(root, "vibest")
await fs.mkdir(home, { mode: 0o700 })
try {
  const seeding = performance.now()
  const events = await Effect.runPromise(seed(path.join(home, "vibest.db")))
  console.log(`seeded ${events} v1 events in ${((performance.now() - seeding) / 1000).toFixed(1)} s`)
  const started = performance.now()
  const p = Bun.spawn([binary, "daemon", "import-check", "--v2"], {
    cwd: root,
    env: envFor(home),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  const ms = performance.now() - started
  console.log(`${stdout}${stderr}`.trim())
  console.log(`import-check --v2: exit ${code}, ${(ms / 1000).toFixed(1)} s wall (limit ${LIMIT_MS / 1000} s)`)
  process.exitCode = code !== 0 || ms > LIMIT_MS ? 1 : 0
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
