# Sessions

A session is one agent working on a task in its own pane and worktree. Each capability below says what it is and when it
counts as working.

## S1. Running a session

`vibest run` starts a session in a new worktree: a linked worktree of the repository, detached, at its HEAD. Its
options work: `--title` names it, `--provider` and `--model` choose what it runs on, `--env` reaches the harness but is
never stored, `--session` picks the herdr session it opens in, and `--peer` runs a second session in the same worktree
in another pane. `vibest ls` shows the title, harness, provider, model and where it runs.

## S5. Reading sessions

`vibest result` is empty before a session's first turn ends and then holds its reply; `vibest status` says vibestd is
running and which process it is; `vibest ls` lists the main agent and each session with its latest result; after
`vibest archive`, only `vibest ls --all` lists the session, as exited.

## S6. Archiving

`vibest archive` of a clean session closes its pane, ends its harness process and removes its worktree. Uncommitted
changes, or commits on no branch, keep the worktree and say why; commits on a branch let the worktree go and the
branch keeps them. `--keep-worktree` keeps a clean worktree and says it was asked to.

## S7. Archive on completion

`vibest run --archive-on-completion` archives the session once, after its completed result reached the main agent.

## S9. A limit on sessions

`VIBEST_MAX_SESSIONS` limits how many sessions run at once, not counting the main agent: one more `vibest run` fails
naming the limit, and starts once a session is archived.

## S20. Ids and peek

`vibest run` answers a UUID; herdr names the agent `s-` and 30 characters of it; `vibest result` takes the first 8
characters and `vibest peek` 12; the session's system prompt is a file of its own. `vibest peek` prints the terminal, at
most N lines with `--lines N`, and refuses an id it does not know.

## S27. Archiving with a process in the worktree

Archiving a session while a process still works in its worktree keeps the worktree and names that process as the
reason.
