import { Schema } from "effect"

import type { Workflow } from "../src/workflow.ts"

const Implemented = Schema.toStandardSchemaV1(
  Schema.Struct({ worktree: Schema.String, branch: Schema.String, commit: Schema.String }),
)

const Verdict = Schema.toStandardSchemaV1(
  Schema.Struct({ approved: Schema.Boolean, issues: Schema.Array(Schema.String) }),
)

const Args = Schema.Struct({
  task: Schema.String,
  gate: Schema.optional(Schema.String),
  maxRounds: Schema.optional(Schema.Number),
})

const decodeArgs = Schema.decodeUnknownSync(Args)
const IMPLEMENTED_FORMAT = "{ worktree: absolute path of your worktree, branch, commit: the commit hash }"
const VERDICT_FORMAT = "{ approved: true only when nothing blocks a merge, issues: one line per real bug }"

const tail = (text: string) => text.split("\n").slice(-40).join("\n")

export default async function implementReviewFix(wf: Workflow) {
  const args = decodeArgs(wf.args)
  const gate = args.gate ?? "pnpm typecheck && pnpm test"
  const maxRounds = args.maxRounds ?? 3

  wf.phase("implement")

  const implementer = wf.session({
    title: "Implement change",
    harness: "claude",
    model: "opus",
    writes: true,
    format: IMPLEMENTED_FORMAT,
  })

  let change = await implementer(`${args.task}\n\nCommit your work on a new branch.`, Implemented)

  const reviewer = wf.session({
    title: "Review change",
    harness: "agy",
    prompt: "You review one change across several rounds. Change no file; judge only what blocks a merge.",
    format: VERDICT_FORMAT,
  })

  for (let round = 1; round <= maxRounds; round += 1) {
    wf.phase(`round ${round}`)
    const checked = await wf.shell(gate, { cwd: change.worktree })

    if (checked.code !== 0) {
      wf.log(`gate failed in round ${round}; the reviewer is not asked`)
      change = await implementer(
        `The gate \`${gate}\` fails in ${change.worktree}:\n${tail(checked.stdout + checked.stderr)}\nFix it and commit.`,
        Implemented,
      )
      continue
    }

    const verdict = await reviewer(
      `Round ${round}: review git -C ${change.worktree} diff origin/main...${change.commit} for the task: ${args.task}`,
      Verdict,
    )

    if (verdict.approved) return { approved: true, rounds: round, branch: change.branch, commit: change.commit }
    change = await implementer(`The review found:\n- ${verdict.issues.join("\n- ")}\nFix them and commit.`, Implemented)
  }

  return { approved: false, rounds: maxRounds, branch: change.branch, commit: change.commit }
}
