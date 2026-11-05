// `bun tools/e2e/src/main.ts [--strict] [area|ID…]`: the script checks of docs/testing/feature-map.md against the built binary, in a
// fresh isolated world. Prints one line per check and writes evidence to tools/e2e/evidence/<run>/. Exit 1 on any fail.
import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "./check.ts"
import daemon from "./scenarios/daemon.ts"
import exits from "./scenarios/exits.ts"
import guard from "./scenarios/guard.ts"
import harness from "./scenarios/harness.ts"
import inbox from "./scenarios/inbox.ts"
import integration from "./scenarios/integration.ts"
import plugins from "./scenarios/plugins.ts"
import project from "./scenarios/project.ts"
import restart from "./scenarios/restart.ts"
import start from "./scenarios/start.ts"
import update from "./scenarios/update.ts"
import { binary, checkout, harnesses, redact, Skip, World } from "./world.ts"

/** The checks by area, in the order they run; an area is selected by its name, a single check by its feature-map ID. */
const areas: Record<string, ReadonlyArray<Check>> = {
  daemon,
  project,
  plugins,
  harness,
  integration,
  guard,
  update,
  start,
  inbox,
  exits,
  restart,
}
const checks = Object.entries(areas).flatMap(([area, list]) => list.map((check) => ({ area, check })))
const strict = process.argv.includes("--strict")
const only = process.argv.slice(2).filter((a) => a !== "--strict")
const unknown = only.filter((a) => !(a in areas) && !checks.some((c) => c.check.id === a))
if (unknown.length) {
  console.error(`unknown ${unknown.join(", ")}; areas: ${Object.keys(areas).join(", ")}`)
  process.exit(1)
}
const selected = only.length ? checks.filter((c) => only.includes(c.area) || only.includes(c.check.id)) : checks

for (const built of [binary, path.join(harnesses, "pi/extension.mjs")]) {
  if (!(await Bun.file(built).exists())) {
    console.error(`no ${built}; run pnpm run build first`)
    process.exit(1)
  }
}

const run = new Date().toISOString().replace(/[:.]/g, "-")
const evidence = path.join(checkout, "tools/e2e/evidence", run)
await fs.mkdir(evidence, { recursive: true })
const world = await World.create()
const results: Array<{ id: string; title: string; outcome: "pass" | "fail" | "skip"; detail?: string }> = []
try {
  for (const { area, check } of selected) {
    const from = world.log.length
    let outcome: "pass" | "fail" | "skip" = "pass"
    let detail: string | undefined
    try {
      await check.run(world, evidence)
    } catch (e) {
      outcome = e instanceof Skip ? "skip" : "fail"
      detail = redact(e instanceof Error ? e.message : String(e))
    }
    // A pane outside this world's herdr sessions (the user's own `vibest`, say) fails the check, whatever it proved.
    const foreign = world.foreignTerminals()
    if (foreign.length > 0) {
      outcome = "fail"
      detail = `${detail ? `${detail}\n` : ""}terminals outside this run's herdr sessions: ${foreign.join(", ")}`
    }
    results.push({ id: check.id, title: check.title, outcome, ...(detail ? { detail } : {}) })
    console.log(
      `${outcome.toUpperCase().padEnd(4)} ${area}: ${check.title}${detail ? `\n     ${detail.split("\n").join("\n     ")}` : ""}`,
    )
    await fs.writeFile(path.join(evidence, `${check.id}.json`), redact(JSON.stringify(world.log.slice(from), null, 2)))
  }
} finally {
  await world.close()
}
await fs.writeFile(path.join(evidence, "report.json"), JSON.stringify({ root: world.root, results }, null, 2))
const count = (o: string) => results.filter((r) => r.outcome === o).length
// A failed run keeps its world for inspection; a clean one removes it.
if (!count("fail")) await fs.rm(world.root, { recursive: true, force: true })
console.log(
  `\n${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped; evidence in ${path.relative(checkout, evidence)}`,
)
// --strict (pnpm verify): a check that could not run proves nothing, so it fails the run.
process.exit(count("fail") || (strict && count("skip")) ? 1 : 0)
