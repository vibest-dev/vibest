# Sessions

A session is one agent working on a task in its own pane and worktree. Each capability below says what it is and when it
counts as working.

## S1. Running a session

`vibest run` starts a session in a new worktree: a linked worktree of the repository, detached, at its HEAD. Its
options work: `--title` names it, `--provider` and `--model` choose what it runs on, `--env` reaches the harness but is
never stored, `--session` picks the herdr session it opens in, and `--peer` runs a second session in the same worktree
in another pane. `vibest ls` shows the title, harness, provider, model and where it runs.

## S5. Reading sessions

`vibest result` is empty before a session's first turn ends and then holds its reply, also as `answer` (the latest ended
turn's status and reply text, kept in the turn row; an interrupted turn has no text); `vibest status` says vibestd is
running and which process it is; `vibest ls` lists the main agent and each session with its latest result; after
`vibest archive`, only `vibest ls --all` lists the session, as exited.

## S6. Archiving

`vibest archive` of a clean session closes its pane, ends its harness process and removes its worktree. The
session's own processes — the harness it recorded, that process's children, and the shell that started it — get up to
10s to exit after the pane closes before the worktree is judged, so a process that is only still exiting does not
keep it. Uncommitted changes, or commits on no branch, keep the worktree and say why; commits on a branch let the
worktree go and the branch keeps them. `--keep-worktree` keeps a clean worktree and says it was asked to.

## S7. Archive on idle

`vibest run --archive-on-idle` archives the session the first time it is idle after a completed turn with nothing it sent
or was sent still waiting, and sends no notice for a clean archive. `--archive-on-completion` is a usage error.

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

## S40. A hint for an inherited agent identity

A program started from inside an agent session (a GUI app, a terminal server) inherits that agent's `VIBEST_*`
environment, and terminals it opens later pass it on, so `vibest` there counts as that agent. A user-only command
refused there names the agent session the shell carries and the way out for a human: run it as
`env -u VIBEST_SESSION_ID -u VIBEST_AGENT vibest <command>`, or open a terminal that was not started from an agent;
that form then works. An agent that changes or clears those variables before running `vibest` is still refused.
