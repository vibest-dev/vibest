import { Schema } from "effect"

import type { Workflow } from "../src/workflow.ts"

const Severity = Schema.Literals(["high", "medium", "low"])

const Finding = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  severity: Severity,
  summary: Schema.String,
})

const Findings = Schema.toStandardSchemaV1(Schema.Struct({ findings: Schema.Array(Finding) }))
const ModuleList = Schema.toStandardSchemaV1(Schema.Array(Schema.String))
const Args = Schema.Struct({ modules: Schema.optional(Schema.Array(Schema.String)) })
const decodeArgs = Schema.decodeUnknownSync(Args)
const ANGLES = ["correctness", "concurrency and cancellation", "error handling"] as const
const RANK = { high: 3, medium: 2, low: 1 } as const

type AuditedFinding = typeof Finding.Type & { readonly module: string; readonly angles: ReadonlyArray<string> }

export const merged = (
  audits: ReadonlyArray<{
    readonly module: string
    readonly angle: string
    readonly findings: ReadonlyArray<typeof Finding.Type>
  }>,
) => {
  const byPlace = new Map<string, AuditedFinding>()

  for (const audit of audits)
    for (const finding of audit.findings) {
      const place = `${finding.file}:${finding.line}`
      const known = byPlace.get(place)
      const stronger = known === undefined || RANK[finding.severity] > RANK[known.severity] ? finding : known
      byPlace.set(place, { ...stronger, module: audit.module, angles: [...(known?.angles ?? []), audit.angle] })
    }

  return [...byPlace.values()].toSorted(
    (x, y) => RANK[y.severity] - RANK[x.severity] || x.file.localeCompare(y.file) || x.line - y.line,
  )
}

export default async function fanoutAudit(wf: Workflow) {
  const args = decodeArgs(wf.args ?? {})

  wf.phase("discover")

  const modules = await wf.step("modules", ModuleList, async () => {
    if (args.modules !== undefined) return [...args.modules]
    const listed = await wf.shell("ls -d packages/*/src")

    return listed.stdout.split("\n").filter((line) => line !== "")
  })

  wf.log(`${modules.length} modules, ${ANGLES.length} angles`)

  wf.phase("audit")
  const jobs = modules.flatMap((module) => ANGLES.map((angle) => ({ module, angle })))

  const audits = await wf.parallel(
    jobs,
    async ({ module, angle }) => {
      const found = await wf.agent({
        title: `Audit ${module} for ${angle}`,
        prompt: `Read ${module} and report real defects of ${angle} only. Change no file.`,
        format: "{ findings: [{ file, line, severity: high|medium|low, summary }] }, an empty list when you find none",
        schema: Findings,
      })

      return { module, angle, findings: found.findings }
    },
    { concurrency: 3 },
  )

  wf.phase("aggregate")
  const findings = merged(audits)
  wf.log(`${findings.length} distinct findings from ${audits.length} audits`)

  return { modules, findings: findings.map((finding) => ({ ...finding, angles: [...finding.angles] })) }
}
