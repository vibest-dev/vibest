# Dynamic Workflows for vibest

**Status:** proposal / prototype on branch `feat/dynamic-workflow-prototype`. For future discussion; prototype branch not for main.

A coordinator agent writes a short TypeScript script (`phase`, `agent`, `session`, `parallel`, `pipeline`,
`shell`, `step`), starts it once, and reads one structured report when it ends or escalates. Every agent the script
starts is an ordinary vibest session (any harness, visible in its pane); the steps between them are plain code and cost
no model tokens.

## 1. What vibest does today (read from the code, not guessed)

| Fact                                                                                                                                                                                                                                                                                                                                                     | Where                                                                                                                                                                        | Consequence for workflows                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vibest run` is refused without a calling session; the caller is `VIBEST_SESSION_ID` from the environment, sent as the RPC claim                                                                                                                                                                                                                         | `packages/cli/src/commands/handlers/run.ts` (`NoCallingSession`), `packages/cli/src/caller.ts`                                                                               | A `bun workflow.ts` started from the coordinator's shell inherits `VIBEST_SESSION_ID`: every agent it starts has **the coordinator as parent**. There is no lighter "controller session" unless the workflow is itself a session. |
| An execution end sends nothing; the reply is read with `vibest result` (`Get` → `reply: { execution, status, text, failure }`)                                                                                                                                                                                                                           | `docs/features/inbox.md` S3, `packages/protocol/src/rpc.ts` (`SessionReply`, `SessionStatusInfo`)                                                                            | Completion and output can be read without any message reaching the coordinator.                                                                                                                                                   |
| A child wakes its creator when it `vibest send`s (the General agent prompt says: send your report to the session that started you), and vibest also notices the creator for failed executions (S50), undeliverable sends (S48), permission waits (`blocked`), unexpected exits / killed pane or harness (S21/S22/S51), and not-started / launch failures | `packages/builtins/src/agent.ts` ("Your Report"), `docs/features/inbox.md` S48, S50; `packages/core/src/session/` (`reconcile`, `exits`, `delivery`, `placement`, `archive`) | Prompt noise is avoidable ("do not send the report"); core notices are not. Under A those notices wake the coordinator; under B they go to the workflow session.                                                                  |
| `maySend`: a session sends only to its creator, its children and its teammates; never to itself                                                                                                                                                                                                                                                          | `packages/core/src/database/inbox.ts` (`maySend`), `packages/core/src/session/sends.ts` (`admit`)                                                                            | The runner, holding the coordinator's claim, **cannot** `vibest send` its result to the coordinator ("a session does not send to itself").                                                                                        |
| `vibest events` is user-only                                                                                                                                                                                                                                                                                                                             | `packages/cli/src/commands/handlers/events.ts` (`userOnly`)                                                                                                                  | A runner started by an agent cannot stream events; it reads `vibest result` with backoff. `no-background-polling` binds vibestd, not clients, and the poll costs no tokens.                                                       |
| Session status `blocked` means a permission wait; a usage limit is a failure whose head matches `rate limit \| usage limit \| too many requests`                                                                                                                                                                                                         | `packages/schema/src/session.ts` (`AgentStatus`), `packages/core/src/replies.ts` (`isUsageLimitError`)                                                                       | Both are readable from `vibest result` and become escalations.                                                                                                                                                                    |
| Each session gets its own worktree by default; `vibest run --share <id>` can share one                                                                                                                                                                                                                                                                   | `vibest run` help in `packages/cli/src/commands/commands.ts`                                                                                                                 | An implement → review → gate chain passes the implementer's worktree path explicitly (the implementer returns it in its JSON); that also avoids `--share`'s shared-worktree git restrictions.                                     |
| A session survives a vibestd restart and `vibest stop`; the next send resumes it                                                                                                                                                                                                                                                                         | `docs/features/recovery.md` S23, owner preferences (idle sessions)                                                                                                           | The journal can keep session ids and continue the same conversation after a crash, a limit or a pause.                                                                                                                            |

## 2. Where execution lives

**A. Client runner over the vibest CLI (prototype).** `bun cli.ts run wf.ts` drives `vibest run / send / result /
interrupt / archive`. Zero new facts, RPCs or core concepts. Costs: children are parented to the coordinator (so
all creator notices still reach it), completion is polled, and the runner cannot message the coordinator: the
coordinator learns the end from the runner's process exit (a background shell task in Claude Code; a foreground
command elsewhere).

**B. Workflow harness plugin (recommended target).** Package the same runner as a harness, `vibest.workflow`
(`packages/plugins/workflow`, off by default): `vibest run workflow --title 'Audit core' -- <script.ts>` starts a
session whose process is the Bun runner instead of a model. Everything falls into place with existing mechanics:

- children are parented to the **workflow session**, so their sends and all creator notices go there, never to the
  coordinator;
- children's sends can wake the runner via `Inbox.Subscribe`, but `Inbox.Take` returns nothing while the workflow
  session has an open execution — a single lifetime execution cannot pull mid-run inbox rows. And if workers follow
  "do not `vibest send`", success produces no inbox row (S3), so Subscribe alone does not wake on completion; B still
  needs `vibest result` (or a wait helper) for child success;
- the workflow's execution end is the workflow's end, its reply is the report (`vibest result <wf>`), and like any agent
  it sends its creator exactly one message (done, or escalated with the question);
- `vibest interrupt <wf>` cancels it (the runner interrupts its live children), `vibest stop`/send resumes it from
  its journal, `vibest peek <wf>` shows the trace timeline in its pane.

This is "all harnesses are plugins" applied once more: core still knows only sessions, parents and inboxes.

**C. First-class core entity.** Rejected: core names no orchestration concept and the ledger must not carry
plugin bookkeeping (owner rules on roles and on facts). B gives the same guarantees without it.

**Recommendation:** ship A as the skill-level tool now (it works on main as is), then B. The only core-adjacent
addition worth considering for A is a generic `vibest wait <id> [--after <execution>]`: a bounded blocking read of
one's own child (an `awaitEvent`, allowed by the polling rule), which removes polling for every agent, not only
workflows. Add it only when B is not coming soon.

## 3. Typed output from terminal harnesses

- **Channel:** the worker's final reply, read with `vibest result`. The SDK appends to the prompt: "End your final reply
  with exactly one fenced json block…" plus the caller's `format` hint. The last fenced `json` block (or the whole reply)
  is parsed. Chosen over an artifact file (needs a path per worktree, stale files survive retries) and over a new
  `vibest workflow finish` command (new CLI surface for no gain).
- **Schema:** any Standard Schema v1 (`Schema.toStandardSchemaV1` from Effect, Zod, Valibot). Output is the schema's
  decoded value, so the script branches on typed data.
- **Repair:** one turn. On a parse or schema failure the SDK `vibest send`s the issues ("approved: Expected boolean") to
  the same session, which keeps its context; a second failure fails the workflow (`OutputInvalid`).
- **Worker rules** (prefixed to every first prompt): the reply is read by a program; do not `vibest send` the report;
  start the final reply with `BLOCKED:` when a person's decision is needed. In A this keeps the coordinator quiet;
  in B a stray send only reaches the workflow session.

## 4. Escalation

| Child state                                                    | Seen as   | Workflow does                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reply starts `BLOCKED:`, or status `blocked` (permission wait) | `blocked` | ends `escalated` with session id and question; session left open. For a `BLOCKED:` text reply the coordinator `vibest send`s an answer and reruns (journal waits for the **next** reply). For a live permission wait (`status === "blocked"`), `vibest send` only queues until idle (S2) — it does not answer the pane prompt; that needs a separate permission path. |
| failure matching the usage-limit pattern                       | `limit`   | ends `escalated`; rerun later re-sends the same turn to the **same** session.                                                                                                                                                                                                                                                                                         |
| other failure                                                  | `failed`  | the step throws `AgentFailed`; the script may catch and retry, otherwise the run ends `failed`; rerun re-sends.                                                                                                                                                                                                                                                       |

## 5. Journal, crash recovery, cancellation

- The journal is a JSON file per run (`--state`, default `<script>.state.json`), keyed by step: `<phase>/<title>/<turn>`
  (or an explicit `key`), `#n` for repeated titles, `step/<key>` for deterministic code steps. It is not the vibest
  ledger: the owner rule keeps plugin bookkeeping out of facts.
- Entry `{ session, after, sent, text }`. Before waiting, the SDK writes `sent: true` with the session id and the last
  seen execution: a runner that dies is rerun and **reattaches** to the agent still working, no second spawn. A
  finished turn stores its final text, which is re-validated against the schema on replay, so steps 1–3 are skipped and
  step 4 runs. `step(key, schema, fn)` journals a computed value the same way.
- `shell()` is not journaled: gates are rerun on purpose because the tree may have changed.
- Cancellation is an `AbortSignal` tree (AsyncLocalStorage scope). SIGINT/SIGTERM abort the root; every in-flight agent
  gets `vibest interrupt` and the run ends `cancelled` (exit 130). `parallel` is fail-fast: the first real failure
  aborts its lane scope, running siblings are interrupted, unstarted items never spawn, and the first non-cancellation
  error is rethrown.
- Archive policy (the delegate skill's rule): a read-only agent (`agent()`, or a `session()` at close or run end) is
  archived once its output is read; `writes: true` agents are kept for the coordinator; escalated, failed and
  cancelled sessions stay open. The report lists every session with `archived | kept | open`. Archives are journaled, so
  a rerun does not archive twice.

## 6. Primitives

```ts
export default async function (wf: Workflow) {
  wf.phase("audit")
  const audits = await wf.parallel(modules, (m) =>
    wf.agent({ title: `Audit ${m}`, prompt: `…`, harness: "pi", schema: Findings }), { concurrency: 3 })
  const impl = wf.session({ title: "Implement", harness: "claude", model: "opus", writes: true })
  const rev = wf.session({ title: "Review", harness: "agy", prompt: "You review across rounds." })
  let change = await impl(task, Implemented)
  const gate = await wf.shell("pnpm test", { cwd: change.worktree })
  const verdict = await rev(`Review ${change.commit}`, Verdict)
  return { … }
}
```

- `agent(opts)` one turn, typed when `schema` is given; `session(opts)` a callable multi-turn handle whose turns are
  serialised. Deliberately two functions instead of one "callable and awaitable" value: a thenable function is
  silently unwrapped by `return` in async code and by `Promise.all`, which would start turns nobody asked for.
- `parallel(items, fn, { concurrency })` ordered results, fail-fast; `pipeline(items, first, then)` per-item chaining
  with no barrier between stages; `shell(cmd, { cwd })` exit code and output; `step(key, schema, fn)`; `phase`, `log`
  feed the trace timeline (stderr lines, and the report).
- Drivers: `VibestCliDriver` (real CLI, `VIBEST_CLI` or `vibest` on PATH, result poll 1 s doubling to 10 s, tolerates
  30 failed CLI calls for a vibestd restart) and `FakeVibestDriver` (in-memory sessions: queued turns, history,
  `BLOCKED:` replies, failures, usage limits, hangs that only an interrupt ends).

## 7. Known ceilings

- A: the runner polls `vibest result`; creator notices still reach the coordinator; worker rules are prompt text an
  agent may ignore. B moves notices off the coordinator but still needs a result/wait path for child success (see §2 B).
- Journal keys come from phase and title; titles in a `parallel` must name their item, or `#n` suffixes depend on
  start order, which a concurrency limit makes nondeterministic.
- Concurrency is per `parallel` call; the owner's limit of three agents at once is the script author's job (examples use
  3). A runner-wide cap is one semaphore when needed.
- No JSON Schema in the prompt: Effect's Standard Schema does not expose one, so the `format` hint is written by hand.

## 8. Verification

On `feat/dynamic-workflow-prototype`, `bun test` under the prototype package (19 tests): parallel order and concurrency,
fail-fast interrupts, serialised multi-turn history, the worker rules on the first prompt, schema repair and its failure,
blocked and limit escalation, archive policy, cancellation, reattach after a runner crash, step replay, the three
examples (fan-out merge, gate failure and review rejection loops across one implementer and one reviewer session, limit
then resume skipping finished steps), and the CLI driver and `cli.ts` end to end against a stub `vibest` executable.
`pnpm lint`, `pnpm format:check` and the prototype `tsc --noEmit` pass there.
