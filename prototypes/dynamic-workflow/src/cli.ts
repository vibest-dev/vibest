import path from "node:path"
import util from "node:util"

import type { Json } from "./driver.ts"
import { Journal } from "./journal.ts"
import { VibestCliDriver } from "./vibest-cli-driver.ts"
import { type RunReport, type TraceEvent, type WorkflowScript, runWorkflow } from "./workflow.ts"

const USAGE = "usage: bun prototypes/dynamic-workflow/src/cli.ts run <workflow.ts> [--args '<json>'] [--state <file>]"

const EXIT_CODES: Record<RunReport["status"], number> = { completed: 0, failed: 1, escalated: 2, cancelled: 130 }

const traceLine = (event: TraceEvent) =>
  [new Date(event.at).toISOString(), event.phase, event.kind, event.title, event.session, event.detail]
    .filter((part) => part !== undefined)
    .join(" | ")

const parsed = util.parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { args: { type: "string" }, state: { type: "string" } },
})

const [command, script] = parsed.positionals

if (command !== "run" || script === undefined) {
  console.error(USAGE)
  process.exit(64)
}

const loaded: { readonly default?: WorkflowScript } = await import(path.resolve(script))
const workflow = loaded.default

if (workflow === undefined) {
  console.error(`${script} has no default export`)
  process.exit(64)
}

const args: Json = parsed.values.args === undefined ? null : JSON.parse(parsed.values.args)
const controller = new AbortController()

process.on("SIGINT", () => controller.abort(new Error("SIGINT")))

process.on("SIGTERM", () => controller.abort(new Error("SIGTERM")))

const report = await runWorkflow(workflow, {
  driver: new VibestCliDriver(),
  journal: await Journal.open(parsed.values.state ?? `${script}.state.json`),
  args,
  signal: controller.signal,
  onTrace: (event) => console.error(traceLine(event)),
})

const { trace, ...summary } = report

console.log(JSON.stringify({ ...summary, steps: trace.length }, null, 2))

process.exit(EXIT_CODES[report.status])
