import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "./check.ts"
import { changedUserFiles, herdrSessionsLeft, userFileHashes } from "./runner/invariants.ts"
import { lastMs, pool, saveMs } from "./runner/pool.ts"
import daemon from "./scenarios/daemon.ts"
import exits from "./scenarios/exits.ts"
import harness from "./scenarios/harness.ts"
import hc from "./scenarios/hc.ts"
import inbox from "./scenarios/inbox.ts"
import integration from "./scenarios/integration.ts"
import plugins from "./scenarios/plugins.ts"
import project from "./scenarios/project.ts"
import restart from "./scenarios/restart.ts"
import start from "./scenarios/start.ts"
import terminalStatus from "./scenarios/terminal-status.ts"
import update from "./scenarios/update.ts"
import { binary, checkout, harnesses, redact, Skip, World } from "./world.ts"

const areas: Record<string, ReadonlyArray<Check>> = {
  daemon,
  project,
  plugins,
  harness,
  integration,
  update,
  start,
  inbox,
  exits,
  restart,
  hc,
  "terminal-status": terminalStatus,
}
const checks = Object.entries(areas).flatMap(([area, list]) => list.map((check) => ({ area, check, id: check.id })))

const args = process.argv.slice(2)
const strict = args.includes("--strict")
const jobsAt = args.indexOf("--jobs")
const jobs = jobsAt === -1 ? undefined : Number(args[jobsAt + 1])
if (jobs !== undefined && !(Number.isInteger(jobs) && jobs > 0)) {
  console.error("--jobs takes a positive whole number")
  process.exit(1)
}
const only = args.filter((a, i) => a !== "--strict" && a !== "--jobs" && i !== jobsAt + 1)
const unknown = only.filter((a) => !(a in areas) && !checks.some((c) => c.id === a))
if (unknown.length) {
  console.error(`unknown ${unknown.join(", ")}; areas: ${Object.keys(areas).join(", ")}`)
  process.exit(1)
}
const selected = only.length ? checks.filter((c) => only.includes(c.area) || only.includes(c.id)) : checks

for (const built of [binary, path.join(harnesses, "pi/extension.mjs")]) {
  if (!(await Bun.file(built).exists())) {
    console.error(`no ${built}; run pnpm run build first`)
    process.exit(1)
  }
}

type Outcome = "pass" | "fail" | "skip" | "flaky-under-load"
type Result = {
  id: string
  area: string
  title: string
  outcome: Outcome
  startedAt: string
  ms: number
  root: string
  detail?: string
}

const run = new Date().toISOString().replace(/[:.]/g, "-")
const evidence = path.join(checkout, "tools/e2e/evidence", run)
await fs.mkdir(evidence, { recursive: true })
const userFilesBefore = await userFileHashes()

const once = async ({ area, check }: (typeof checks)[number], evidenceName: string): Promise<Result> => {
  const startedAt = new Date()
  const world = await World.create()
  let outcome: Outcome = "pass"
  let detail: string | undefined
  const problem = (text: string) => {
    outcome = "fail"
    detail = `${detail ? `${detail}\n` : ""}${text}`
  }
  try {
    await check.run(world, evidence)
  } catch (e) {
    outcome = e instanceof Skip ? "skip" : "fail"
    detail = redact(e instanceof Error ? e.message : String(e))
  }
  const foreign = world.foreignTerminals()
  if (foreign.length > 0) problem(`terminals outside this check's herdr sessions: ${foreign.join(", ")}`)
  await world.close().catch((e: unknown) => problem(`closing the world: ${String(e)}`))
  const left = await herdrSessionsLeft(world.herdrSession)
  if (left.length > 0) problem(`herdr sessions left after the check: ${left.join(", ")}`)
  await fs.writeFile(path.join(evidence, `${evidenceName}.json`), redact(JSON.stringify(world.log, null, 2)))
  if (outcome !== "fail") await fs.rm(world.root, { recursive: true, force: true })
  return {
    id: check.id,
    area,
    title: check.title,
    outcome,
    startedAt: startedAt.toISOString(),
    ms: Date.now() - startedAt.getTime(),
    root: world.root,
    ...(detail ? { detail } : {}),
  }
}

const print = (r: Result) =>
  console.log(
    `${r.outcome.toUpperCase().padEnd(4)} ${r.area}: ${r.id} ${r.title} (${(r.ms / 1000).toFixed(1)} s)${r.detail ? `\n     ${r.detail.split("\n").join("\n     ")}` : ""}`,
  )

const t0 = Date.now()
const known = await lastMs()
const longestFirst = [...selected].sort((a, b) => (known[b.id] ?? 60_000) - (known[a.id] ?? 60_000))
const results = new Map<string, Result>()
await pool(
  longestFirst,
  async (c) => {
    const r = await once(c, c.id)
    results.set(c.id, r)
    print(r)
  },
  jobs,
)
for (const c of selected.filter((c) => results.get(c.id)?.outcome === "fail")) {
  console.log(`RERUN ${c.id} alone`)
  const again = await once(c, `${c.id}.alone`)
  print(again)
  if (again.outcome === "pass") results.set(c.id, { ...results.get(c.id)!, outcome: "flaky-under-load" })
}
const ordered = selected.map((c) => results.get(c.id)!)
await saveMs(Object.fromEntries(ordered.filter((r) => r.outcome === "pass").map((r) => [r.id, r.ms])))

const changed = changedUserFiles(userFilesBefore, await userFileHashes())
const invariants = changed.length ? [`user files changed during the run: ${changed.join(", ")}`] : []
for (const line of invariants) console.log(`FAIL ${line}`)
await fs.writeFile(
  path.join(evidence, "report.json"),
  JSON.stringify({ wallMs: Date.now() - t0, userFiles: userFilesBefore, invariants, results: ordered }, null, 2),
)
const count = (o: Outcome) => ordered.filter((r) => r.outcome === o).length
console.log(
  `\n${count("pass")} passed, ${count("fail")} failed, ${count("flaky-under-load")} flaky under load, ${count("skip")} skipped in ${((Date.now() - t0) / 1000).toFixed(0)} s; evidence in ${path.relative(checkout, evidence)}`,
)
process.exit(count("fail") || count("flaky-under-load") || invariants.length || (strict && count("skip")) ? 1 : 0)
