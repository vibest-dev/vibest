---
name: dynamic-workflow
description: Run a multi-step, multi-agent job (fan-out audits, implement then review then fix loops, research with resume) as one TypeScript workflow script instead of orchestrating each step by hand. Use when a job has more than three agent steps, a loop, or a fan-out, and the steps between agents are mechanical.
---

# Dynamic workflow

You write a short script; the runner starts the agents, passes typed results between them, runs shell gates, and gives
you one JSON report when everything ends or something needs you. The agents it starts are normal sessions (their parent
is you) whose final reply is read by the runner: they do not message you per step.

## Write

Put the script at `$VIBEST_PROJECT_DIR/artifacts/<your agent id>-<name>.ts`. Import from the prototype checkout:

```ts
import { Schema, standard, type Workflow } from "<checkout>/prototypes/dynamic-workflow/src/index.ts"

const Verdict = standard(Schema.Struct({ approved: Schema.Boolean, issues: Schema.Array(Schema.String) }))

export default async function (wf: Workflow) {
  wf.phase("review")
  const reviews = await wf.parallel(
    ["core", "cli"],
    (module) =>
      wf.agent({
        title: `Review ${module}`,
        harness: "pi",
        prompt: `Review packages/${module}/src …`,
        schema: Verdict,
        format: "{ approved, issues: [one line per real bug] }",
      }),
    { concurrency: 3 },
  )
  return { blocking: reviews.flatMap((r) => r.issues) }
}
```

- `wf.agent({ title, prompt, harness?, model?, provider?, agent?, schema?, format?, writes? })`: one turn. With `schema`
  it returns the validated value; a malformed reply gets one repair turn.
- `wf.session({ title, prompt?, … })`: a callable for several turns in one conversation (`await rev("round 2", Verdict)`).
- `wf.parallel(items, fn, { concurrency })`, `wf.pipeline(items, first, then)`, `wf.shell(cmd, { cwd })`,
  `wf.step(key, schema, fn)`, `wf.phase(name)`, `wf.log(text)`, `wf.args`.

Rules:

- At most three agents at once: pass `{ concurrency: 3 }`.
- Give every agent a title that names its item ("Audit core"): titles are the resume keys.
- `writes: true` for an agent that changes code: it is kept. Read-only agents are archived once their output is read.
- Each agent has its own worktree: ask a code-writing agent to return its worktree path and commit in its JSON, and pass
  them to gates (`cwd`) and reviewers.
- Branch only on schema-validated values, never on prose.

## Run

```sh
bun <checkout>/prototypes/dynamic-workflow/src/cli.ts run <script.ts> [--args '<json>'] [--state <file>]
```

Run it as a background task when your harness has one, otherwise in the foreground with a long timeout. Trace lines go
to stderr; the report is the JSON on stdout. Exit codes: 0 completed, 1 failed, 2 escalated, 130 cancelled.

## Read the report

- `completed`: `result` is what the script returned; `sessions` lists each agent as archived, kept or open. Check kept
  code sessions as the delegate skill says (diff, proving check) before reporting success.
- `escalated`: `escalation.kind` is `blocked` (an agent asks a person's decision, or waits for a permission) or `limit`
  (usage limit). For `blocked`, answer that session with `vibest send <session> -- '<answer>'` or ask the user; then
  run the same command again. For `limit`, run it again later. The journal skips finished steps and continues the
  same sessions.
- `failed`: `error` names the agent and its failure; fix the cause or the script and run again (finished steps are
  skipped).
- `cancelled`: the run was interrupted; its live agents were interrupted too.
