import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { endNoted, reapEndedRuns, startWatch, survivors } from "../../reap.ts"
import type { Check } from "./check.ts"
import { cached, cacheKeys, rememberPasses } from "./runner/cache.ts"
import { changedUserFiles, herdrSessionsLeft, historyNaming, userFileHashes } from "./runner/invariants.ts"
import { lastMs, pool, saveMs } from "./runner/pool.ts"
import { parseShard, shardOf } from "./runner/shard.ts"
import daemon from "./scenarios/daemon.ts"
import delivery from "./scenarios/delivery.ts"
import entrySession from "./scenarios/entry.ts"
import exits from "./scenarios/exits.ts"
import harness from "./scenarios/harness.ts"
import hc from "./scenarios/hc.ts"
import inbox from "./scenarios/inbox.ts"
import integration from "./scenarios/integration.ts"
import machinesHerdr from "./scenarios/machines-herdr.ts"
import machines from "./scenarios/machines.ts"
import plugins from "./scenarios/plugins.ts"
import project from "./scenarios/project.ts"
import restart from "./scenarios/restart.ts"
import routing from "./scenarios/routing.ts"
import sessions from "./scenarios/sessions.ts"
import start from "./scenarios/start.ts"
import terminalStatus from "./scenarios/terminal-status.ts"
import update from "./scenarios/update.ts"
import {
  binary,
  checkout,
  compiled,
  harnesses,
  ledgerSnapshot,
  method,
  privateIn,
  redactor,
  removeExpiredWorlds,
  removeWorldDir,
  Skip,
  World,
} from "./world.ts"
import { capture } from "./world/user-env.ts"

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
  sessions,
  delivery,
  routing,
  entry: entrySession,
  machines: [...machines, ...machinesHerdr],
  "terminal-status": terminalStatus,
}
const checks = Object.entries(areas).flatMap(([area, list]) => list.map((check) => ({ area, check, id: check.id })))

const userFileInvariantAfterEveryRun = [{ id: "I6", tier: "gate", covers: [] }]
if (process.argv.includes("--list")) {
  console.log(
    JSON.stringify([
      ...checks.map((c) => ({ id: c.id, tier: c.check.tier ?? "gate", covers: c.check.covers ?? [] })),
      ...userFileInvariantAfterEveryRun,
    ]),
  )
  process.exit(0)
}

const args = process.argv.slice(2)
const strict = args.includes("--strict")
const noCache = args.includes("--no-cache")
const valueOf = (flag: string) => {
  const at = args.indexOf(flag)
  if (at === -1) return undefined
  const value = args[at + 1]
  args.splice(at, 2)
  return value ?? ""
}
const jobsText = valueOf("--jobs")
const jobs = jobsText === undefined ? undefined : Number(jobsText)
if (jobs !== undefined && !(Number.isInteger(jobs) && jobs > 0)) {
  console.error("--jobs takes a positive whole number")
  process.exit(1)
}
const tier = valueOf("--tier") ?? "gate"
if (!["gate", "slow", "agent", "all"].includes(tier)) {
  console.error("--tier is gate, slow, agent or all")
  process.exit(1)
}
const elsewhere = (valueOf("--elsewhere") ?? "").split(",").filter(Boolean)
const shardText = valueOf("--shard")
const shard = shardText === undefined ? undefined : parseShard(shardText)
if (shardText !== undefined && shard === undefined) {
  console.error("--shard takes k/n, for example 2/6")
  process.exit(1)
}
const only = args.filter((a) => a !== "--strict" && a !== "--no-cache")
const groupOf = (a: string, c: (typeof checks)[number]) => c.id.startsWith(`${a}-`)
const named = (a: string, c: (typeof checks)[number]) => c.id === a || (c.check.covers ?? []).includes(a)
const unknown = [...only, ...elsewhere].filter(
  (a) => !(a in areas) && !checks.some((c) => named(a, c) || groupOf(a, c)),
)
if (unknown.length) {
  console.error(`unknown ${unknown.join(", ")}; areas: ${Object.keys(areas).join(", ")}`)
  process.exit(1)
}
const inTier = (c: (typeof checks)[number]) => tier === "all" || (c.check.tier ?? "gate") === tier
const everySelected = checks.filter(
  (c) =>
    !elsewhere.includes(c.id) &&
    (only.length
      ? only.some((a) => named(a, c)) || ((only.includes(c.area) || only.some((a) => groupOf(a, c))) && inTier(c))
      : inTier(c)),
)
const selected = shard === undefined ? everySelected : shardOf(everySelected, shard)
if (shard !== undefined) console.log(`SHARD ${shard.index}/${shard.count}: ${selected.map((c) => c.id).join(" ")}`)
for (const id of elsewhere) console.log(`ELSEWHERE ${id}: not run here; another machine's run proves it`)

for (const built of [binary, path.join(harnesses, "pi/extension.mjs"), path.join(harnesses, "pi/presentation.mjs")]) {
  if (!(await Bun.file(built).exists())) {
    console.error(`no ${built}; run pnpm run build first`)
    process.exit(1)
  }
}

await reapEndedRuns()
const tracked = path.join(os.tmpdir(), `vibest-reap-e2e-${process.pid}`)
await fs.writeFile(tracked, "")
process.env.VIBEST_REAP_FILE = tracked
startWatch(process.pid, tracked)

await removeExpiredWorlds()

type Outcome = "pass" | "cached" | "fail" | "skip" | "flaky-under-load"
type Result = {
  id: string
  area: string
  tier: string
  title: string
  outcome: Outcome
  startedAt: string
  ms: number
  root: string
  detail?: string
}

const run = `${new Date().toISOString().replace(/[:.]/g, "-")}-${method}`
const evidence = path.join(checkout, "tools/e2e/evidence", run)
await fs.mkdir(evidence, { recursive: true })
const worlds: Array<string> = []
const userFilesBefore = await userFileHashes()
const login = capture()
const redact = redactor(login)

const once = async ({ area, check }: (typeof checks)[number], evidenceName: string): Promise<Result> => {
  const startedAt = new Date()
  const world = await World.create(login)
  worlds.push(world.root)
  let outcome: Outcome = "pass"
  let detail: string | undefined
  const problem = (text: string) => {
    outcome = "fail"
    detail = `${detail ? `${detail}\n` : ""}${text}`
  }
  try {
    if (check.entry) await world.entry()
    await check.run(world, evidence)
  } catch (e) {
    outcome = e instanceof Skip ? "skip" : "fail"
    detail = redact(e instanceof Error ? e.message : String(e))
  }
  const foreign = world.foreignTerminals()
  if (foreign.length > 0) problem(`terminals outside this check's herdr sessions: ${foreign.join(", ")}`)
  await world.close().catch((e: unknown) => problem(`closing the world: ${String(e)}`))
  const ledger = await world.vibest(["daemon", "import-check"]).catch((e: unknown) => ({
    code: 1,
    stdout: "",
    stderr: String(e),
  }))
  if (ledger.code !== 0) problem(`import-check of the world's database: ${ledger.stderr}${ledger.stdout}`)
  const snapshot = ledgerSnapshot(world.vibestHome)
  if (snapshot !== undefined)
    await fs.writeFile(path.join(evidence, `${evidenceName}.ledger.json`), redact(JSON.stringify(snapshot, null, 2)))
  const left = await herdrSessionsLeft(world.herdrSession)
  if (left.length > 0) problem(`herdr sessions left after the check: ${left.join(", ")}`)
  await fs.writeFile(path.join(evidence, `${evidenceName}.json`), redact(JSON.stringify(world.log, null, 2)))
  if (outcome !== "fail") {
    await removeWorldDir(world.root)
    if (
      await fs.stat(world.root).then(
        () => true,
        () => false,
      )
    )
      problem(`world left at ${world.root}`)
  }
  const still = survivors(tracked, world.root)
  if (still.length > 0) {
    problem(`processes still alive: ${still.join("; ")}`)
    await endNoted(tracked, world.root)
  }
  return {
    id: check.id,
    area,
    tier: check.tier ?? "gate",
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
const results = new Map<string, Result>()
const keyOf = await cacheKeys({ login, binaries: [binary, compiled], harnesses, method, userFiles: userFilesBefore })
const keys = new Map(await Promise.all(selected.map(async (c) => [c.id, await keyOf(c.area, c.id)] as const)))
const cacheable = (c: (typeof checks)[number]) => !noCache && (c.check.tier ?? "gate") !== "agent"
for (const c of selected)
  if (cacheable(c) && (await cached(keys.get(c.id)!))) {
    const r: Result = {
      id: c.id,
      area: c.area,
      tier: c.check.tier ?? "gate",
      title: c.check.title,
      outcome: "cached",
      startedAt: new Date().toISOString(),
      ms: 0,
      root: "",
    }
    results.set(c.id, r)
    print(r)
  }
const known = await lastMs()
const longestFirst = selected
  .filter((c) => !results.has(c.id))
  .sort((a, b) => (known[b.id] ?? 60_000) - (known[a.id] ?? 60_000))
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

const stillRunning = survivors(tracked)
if (stillRunning.length > 0) await endNoted(tracked)
const changed = changedUserFiles(userFilesBefore, await userFileHashes())
const typedIntoHistory = await historyNaming(worlds)
const leaked = (
  await Promise.all(
    (await fs.readdir(evidence, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map(async (e) => {
        const file = path.join(e.parentPath, e.name)
        return privateIn(await fs.readFile(file, "utf8")).length > 0 ? [path.relative(evidence, file)] : []
      }),
  )
).flat()
const invariants = [
  ...(changed.length ? [`user files changed during the run: ${changed.join(", ")}`] : []),
  ...(typedIntoHistory.length
    ? [`commands typed in this run's worlds reached the user's shell history: ${typedIntoHistory.join(", ")}`]
    : []),
  ...(leaked.length ? [`evidence holds a user model, provider or account value: ${leaked.join(", ")}`] : []),
  ...(stillRunning.length > 0 ? [`processes still alive: ${stillRunning.join("; ")}`] : []),
]
for (const line of invariants) console.log(`FAIL ${line}`)
await rememberPasses(
  selected
    .filter((c) => cacheable(c) && results.get(c.id)?.outcome === "pass")
    .map((c) => ({ key: keys.get(c.id)!, id: c.id })),
  invariants,
)
await fs.writeFile(
  path.join(evidence, "report.json"),
  redact(
    JSON.stringify({ wallMs: Date.now() - t0, userFiles: userFilesBefore, invariants, results: ordered }, null, 2),
  ),
)
const count = (o: Outcome) => ordered.filter((r) => r.outcome === o).length
console.log(
  `\n${count("pass")} passed, ${count("cached")} cached, ${count("fail")} failed, ${count("flaky-under-load")} flaky under load, ${count("skip")} skipped in ${((Date.now() - t0) / 1000).toFixed(0)} s; evidence in ${path.relative(checkout, evidence)}`,
)
await fs.rm(tracked, { force: true })
process.exit(count("fail") || count("flaky-under-load") || invariants.length || (strict && count("skip")) ? 1 : 0)
