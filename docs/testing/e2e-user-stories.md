# End-to-end user stories

One story per multi-agent pattern from the survey (architecture §1, §4), plus the stories every pattern relies on.
Each story is run for real: herdr, CLI agents, models, under the isolation of [e2e-plan.md](e2e-plan.md).

**Status** says what can be checked now:

- **now**: today's code (omac semantics: coordinator, session, `run <harness>`, `--peer`, `--archive-on-completion`).
- **after refactor**: needs the vibest domain (Run, `--agent`, `--in`, `once`/`kept`, DynamicWorkflow).
  Until then, the story is the acceptance test for that refactor.

## Fixture

`shop`: a small TypeScript repository with a local bare `origin`, `pnpm test` green except one seeded bug
(`login()` accepts an expired token; one failing test), and `docs/architecture.md` in the Project store.
Every prompt asks for a nonce in the final reply, so a result can be matched to its request.

## Stories

### S1. Direct launch (type A)

_As a developer, I start one agent on a task from my terminal and read its result when it is done._

| Step                                                                                | Expect                                                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `vibest run claude "add a --verbose flag to the CLI; reply DONE-<nonce>"` in `shop` | a pane in herdr, a new worktree off `HEAD`, row `working`                                   |
| wait                                                                                | row `idle`, turn `completed`; `vibest result <id>` holds `DONE-<nonce>` in `<agent-result>` |
| `vibest archive <id>` after the worker pushed its branch                            | pane closed with PID proof, worktree removed, branch kept on `origin`                       |

Status: now. Run once per harness (Claude, Pi, Cursor).

### S2. Delegation: supervisor and workers (type B)

_As a developer, I chat with the main Agent; it splits a feature across workers, and their results come back into
the same conversation without my polling._

| Step                                                                         | Expect                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `vibest` in `shop`; ask: "add CSV export and fix the login bug, in parallel" | the main Agent (coordinator) runs two workers on different harnesses; it edits no files itself                                        |
| workers finish at different times                                            | each result arrives in the main conversation as new input, once, in arrival order; nothing is pasted while the main Agent is mid-turn |
| a worker calls `vibest report "blocked on X"`                                | the report reaches the main conversation; the main Agent answers with `vibest send`                                                   |
| main Agent merges                                                            | it summarises both branches; `pnpm test` is green on each                                                                             |

Status: now (Claude main Agent uses the inbox bridge; Pi main Agent uses its extension).

### S3. Committee (type B, skill)

_As a tech lead, I want two or three models to argue a design until they agree, and see where they differed._

| Step                                                                                              | Expect                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| ask the main Agent: "committee: should sessions be stored in SQLite or files? Claude, Cursor, Pi" | three read-only members, one per harness, same question                                                                        |
| rounds                                                                                            | the main Agent forwards each member's argument to the others with `vibest send`; every answer returns to the main conversation |
| end                                                                                               | a summary listing the agreement and the disagreements; no member changed a file (worktrees clean)                              |

Status: now as coordinator behaviour; after refactor as the `committee` skill with all members in one Run (`--in`),
one grouped Message.

### S4. Handoff (type B, skill)

_As a developer, I want a planner to write the plan and an implementer to carry it out in the same place._

| Step                                                                      | Expect                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| ask: "handoff: plan the CSV export with Claude, implement it with Cursor" | planner writes `PLAN.md` in its worktree and finishes                       |
| main Agent starts the implementer in the planner's worktree               | same worktree (`--peer` now; same Run later); it reads `PLAN.md`            |
| archive both                                                              | the shared worktree is removed only by its owner; the peer never removes it |

Status: now (`--peer`); after refactor as the `handoff` skill.

### S5. Advisor (type B, skill)

_As a developer, I want a second opinion on the work in progress without anyone touching the code._

| Step                                                                          | Expect                                                                                         |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| while a worker is on the login bug, ask: "advisor: review that worker's diff" | a read-only Agent in the main checkout                                                         |
| advisor tries to edit a file or run `vibest run`                              | refused (read-only arguments, guard)                                                           |
| suggestions                                                                   | arrive in the main conversation; the main Agent forwards them to the worker with `vibest send` |

Status: now (read-only by instruction plus guard); after refactor with `access: read` enforced by the adapter.

### S6. Race / best-of-N (type F, skill)

_As a developer, I want three attempts at a hard fix and keep the best one._

| Step                                      | Expect                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| ask: "race: fix the login bug three ways" | three workers, three separate worktrees                                        |
| all finish                                | the main Agent compares `pnpm test` and diff size per worktree, names a winner |
| keep one                                  | the winner's branch is pushed; the other two are archived, worktrees removed   |

Status: now (three `run`s); after refactor as one Run with N Agents and one grouped result.

### S7. Check loop / self-healing (type D, program)

_As a developer, I want an agent to keep fixing until the tests pass, at most N tries._

| Step                                                                                                                    | Expect                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| now: tell the main Agent "fix login; after each result run `pnpm test` in its worktree and send failures back, 3 tries" | each failing run's output goes back as the next prompt; stops at green or after 3 |

Status: now as coordinator behaviour.

### S8. DynamicWorkflow (type D, program)

_As a developer, I want a scripted pipeline: plan, then two parallel implementations, then a judge._

| Step                                                             | Expect                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `vibest run "add CSV export" --dynamic-workflow plan-impl-judge` | phases visible; `parallel` starts two Agents together                   |
| edit the judge step, resume                                      | only the judge re-runs; earlier `agent()` calls replay from the journal |
| `checkpoint`                                                     | a herdr popup asks the user before the judge runs                       |

Status: after refactor (optional plugin).

## Stories every pattern relies on

### S9. Keep or end a worker

_I want some workers to stay for follow-up questions and others to vanish when done._

- Kept (default): after the result, `vibest send <id> "also handle empty files"` gets a second answer in the main
  conversation; the pane stays until `vibest archive`.
- Once: `--archive-on-completion` now (`--once` after refactor) closes the pane and removes the clean worktree right
  after the completed result reaches the main Agent; a dirty or unpushed worktree is kept, and the reason is shown.

Status: now.

### S10. Crash and restart in the middle of delegation

_If the daemon or a pane dies, I lose no result and nothing is sent twice._

| Fault                                  | Expect                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| kill the daemon while two workers work | next `vibest` command restarts it; both results still reach the main Agent once   |
| close a worker's pane mid-turn         | turn ends `lost` within about 10 s; the main Agent is told                        |
| model that does not exist              | a failed result with Claude's error, no screen text; `vibest peek` shows the pane |
| `vibest update` while workers are busy | the replacement waits or names its blockers; no running worker is cut off         |

Status: now.

### S11. Boundaries

_Workers cannot escape their role._

- A worker running `vibest run`, `vibest archive`, or reading the Project store's `docs/` and `memory/` directly is
  refused by the guard in its own CLI (Claude, Pi, Cursor each).
- `VIBEST_MAX_SESSIONS=2`: the third `run` gets `LimitReached`.
- Typing into a worker's pane by hand works and does not interrupt the main conversation.

Status: now.

### S12. Shared knowledge and routing

_Workers share Project knowledge, and a plugin picks the harness for me._

- The main Agent writes `memory/decisions.md` with `vibest project write`; a worker's rules include it; a stale
  `ifVersion` write is refused.
- A routing plugin in `$VIBEST_HOME/plugins` picks Cursor for `test`-related tasks; `vibest plugins` shows its calls;
  editing the plugin file changes the choice without a daemon restart; a plugin that refuses blocks the run with its
  reason.

Status: now.

### S13. Several repositories

_I work across several repositories. Each keeps its own Project knowledge and worktrees, the same repository is one
Project wherever I stand in it, and I can run agents in two repositories at once without them mixing._

A Project is found by the realpath of its main checkout (or of a directory of repositories), never by its `origin`;
`origin` only recognizes a checkout that moved (docs/design/schema.md, Projects).

Fixture, beside `shop`:

- `admin`: a second repository with its own bare `origin`.
- `shop/vendor/sdk`: a repository nested in `shop`'s working tree (its own `origin`), ignored by `shop`'s `.gitignore`.
- `notes`: a repository with no `origin`.
- `shop-copy`: a second clone of `shop`'s `origin`.
- `shop-wt`: a linked worktree of `shop` (`git worktree add`).

| Step                                                                                                           | Expect                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| in `shop`: `vibest project write --if-version new docs a.md A-<nonce>`; in `admin`: `vibest project list docs` | `admin` has no `docs/a.md`; `project info` shows a different `scratchPath`                                                           |
| `vibest project read docs a.md` in `shop/src` and in `shop-wt`                                                 | `A-<nonce>` both times: a subdirectory and a linked worktree are `shop`'s Project                                                    |
| `vibest project info` / `list docs` in `shop/vendor/sdk`                                                       | its own Project, without `docs/a.md`                                                                                                 |
| in `notes`: write, then `project info` twice                                                                   | works without an `origin`; the same Project both times                                                                               |
| move `notes` to `notes-moved`; `project list docs`                                                             | a new, empty Project (no `origin` to recognize the move by)                                                                          |
| `vibest project read docs a.md` in `shop-copy`                                                                 | not found: another clone of one `origin` is another Project                                                                          |
| `vibest run cursor -- "<task>; reply DONE-<nonce1>"` in `shop` and `… DONE-<nonce2>` in `admin`, back to back  | two rows in `vibest ls`, each with its own repository; each worktree is a checkout of its own `origin` (`git remote get-url origin`) |
| wait for both                                                                                                  | `vibest result <id>` holds the right nonce for each; neither result reached the other's repository                                   |
| the `shop` worktree                                                                                            | does not contain `vendor/sdk` (a nested repository is never copied)                                                                  |
| `vibest archive` both                                                                                          | both panes closed, worktrees removed, branches kept                                                                                  |

Status: now, except the M7 rows below.

After M7 (`plugin-git`), as its acceptance test:

| Step                                                  | Expect                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `vibest project create work --from shop --from admin` | `work/shop` and `work/admin` are copies (local clones), not symlinks; the originals untouched |
| `vibest` in `work`                                    | one main Agent for the whole Project; `project info` lists both folders                       |
| `vibest run … --in isolated`                          | one worktree per repository inside the Workspace, one branch each                             |
| `admin`'s worktree dirty, `shop`'s clean; archive     | refused, naming `admin` and what would be lost                                                |
| a plain directory as a Project                        | only the `root` Workspace; `isolated` is refused with a reason                                |

## Not covered

Work-item intake (type C) and the message mesh (type E) are deferred (architecture §1); multiple machines are not
tested here.
