# Sessions

A session is one agent working on a task in its own pane and worktree. Each capability below says what it is and when it
counts as working.

## S1. Running a session

`vibest run`, run by an agent in a session (the entry session or another one), starts a session in a new worktree: a linked worktree of the
repository, detached, at its HEAD. Its options work: `--title` names it, `--provider` and `--model` choose what it runs on, `--env` reaches the harness but is
never stored, `--session` picks the herdr session it opens in, and `--share` runs a second session in the same worktree
in another pane. `--file <path>` attaches a file (S57). `vibest ls` shows the title, harness, provider, model and where it runs. The started session records the session that ran
it as its creator. `vibest run` in a terminal that is not a session is refused and says to open a session with bare
`vibest`: no worktree or pane is made.

## S5. Reading sessions

`vibest result` has no `reply` before a session's first execution ends and then holds its reply as `reply` (the latest ended
execution's status and reply text, kept in the execution row; an execution vibestd ended itself, lost or by an exit, has no text; a
reply that arrives after vibestd gave up its execution as lost is an execution of its own, not attached back); `vibest status` says vibestd is
running and which process it is; `vibest ls` lists the entry session and each session with its latest reply. When one session's worktree cannot be read,
the list still has every session: that row's `git.unknown` is the error (`git cannot read it` when the folder is gone)
and the other rows keep their git state. After
`vibest archive`, only `vibest ls --all` lists the session, as exited.

## S6. Archiving

`vibest archive` of a clean session closes its pane, ends its harness process and removes its worktree. The
session's own processes — the harness it recorded, that process's children, and the shell that started it — get up to
10s to exit after the pane closes before the worktree is judged, so a process that is only still exiting does not
keep it. Uncommitted changes, or commits on no branch, keep the worktree and say why; commits on a branch let the
worktree go and the branch keeps them. `--keep-worktree` keeps a clean worktree and says it was asked to. A worktree kept
because another live session shares it (`--share`), or because some other process works in it, is named in the
reasons, and the archive is still finished: the session counts as ended, and nothing about it comes back later.

## S7. Archive on idle

`vibest run --archive-on-idle` archives the session the first time it is idle after a completed execution with nothing it sent
or was sent still waiting, and sends no notice for a clean archive. The builtin plugin `archive-on-idle` does that;
`"-archive-on-idle"` in `vibest.json` removes it, and a session started with the flag then stays until `vibest archive`.
`--archive-on-completion` is a usage error.

## S9. A limit on sessions

`VIBEST_MAX_SESSIONS` limits how many sessions run at once, not counting the entry session: one more `vibest run` by the
entry session fails naming the limit, and starts once a session is archived.

## S20. Ids and peek

`vibest run` answers the session that ran it a UUID; herdr names the agent `s-` and 30 characters of it; `vibest result` takes the first 8
characters and `vibest peek` 12; the session's system prompt is a file of its own. `vibest peek` prints the terminal, at
most N lines with `--lines N`, and refuses an id it does not know.

## S27. Archiving with a process in the worktree

Archiving a session while a process still works in its worktree keeps the worktree and names that process as the
reason.

## S40. A hint for an inherited agent identity

A program started from inside an agent session (a GUI app, a terminal server) inherits that agent's `VIBEST_*`
environment, and terminals it opens later pass it on, so `vibest` there counts as that agent. A user-only command
refused there names the agent session the shell carries and the way out for a human: run it as
`env -u VIBEST_SESSION_ID vibest <command>`, or open a terminal that was not started from an agent;
that form then works. An agent that changes or clears that variable before running `vibest` is still refused.

## S41. Who started a session

`vibest run` in a terminal that is not a session is refused with `NoCallingSession`, which says to run `vibest` to open
a session; no worktree or pane is made. A session started by `vibest run` records the session that ran it as its creator,
whether the creator is the entry session or another session, and on another machine it records the session there.

## S42. Agent definitions

Every session runs as an agent definition: an id, a description and a system prompt, optionally with a guard that adds
rules to the ones every agent has. Bare `vibest` opens the entry session as `coordinator`; `vibest run` starts a
`general` session unless `--agent` names another registered id, and on another machine the same id is looked up there. An
id that is not registered is refused with the registered ids listed, before any worktree or pane is made. A session may
manage (send to, interrupt, peek at, remove) only the sessions it started.

## S57. Attaching files to a run

`vibest run --file <path>`, repeated, attaches files of any type. The command reads each file on the machine that runs
it and vibestd copies it to `<project folder>/sessions/<session id>/files/<file name>`; two files of the same name are
both kept (the second as `<name>-2.<extension>`). The file content is not put into the task: the task ends with one line,
`Attached files: <absolute path>, …`, naming the copies, and the agent reads them itself (every harness can read the
project folder). A plugin sees that line in `agent.start.before` `prompt` and the copies' paths in `files`. Archiving the
session removes `<project folder>/sessions/<session id>/`. A file over 10 MiB, one that cannot be read, or one that is
not a regular file refuses the run. With `--machine`, the files go with the run and the vibestd there copies them into its own project folder, so
the line names paths on that machine; a vibestd there that cannot take files refuses the run and says to run `vibest
update` there.

## S58. Stopping a session

`vibest stop <id>`, run by the session that started it, ends the session's harness process and closes its terminal; a
working session is interrupted first, as `vibest archive` does, and that execution ends interrupted. The session, its
worktree and branch, and its messages stay: `vibest ls --all` lists it as exited, and the next `vibest send` to it
resumes the same conversation in a new terminal, where the message is answered. A message already waiting for it when
it stops resumes it at once. The ledger records the process's end as `stopped` and who stopped it. The entry session
and an archived session are refused. A plugin stops a session with `ctx.session.stop(id)`, recorded as the plugin.
