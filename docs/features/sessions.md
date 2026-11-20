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
or was sent still waiting, and sends no notice for a clean archive. The builtin plugin `vibest.archive-on-idle` does that;
`"-vibest.archive-on-idle"` in `vibest.json` removes it, and a session started with the flag then stays until `vibest archive`.
`--archive-on-completion` is a usage error.

## S9. A limit on running harnesses

`"concurrency": [{ "max": N }]` in `~/.vibest/vibest.json` lets at most N harness processes run at once on this
machine, across all projects and the entry sessions included; without the key there is no limit, and a change to it
applies without a restart. When the limit is reached, `vibest run` still records the session and its task and returns
at once, but its harness starts only when a running harness on this machine ends (it exits, is stopped or archived) or
the limit is raised or removed, first come first served; meanwhile `vibest ls` and `vibest result` show it with
`"waitingToStart": true`. A send to a session whose harness has exited waits the same way. Entry sessions always open,
and their harnesses count toward the limit. Interrupting or archiving a session that waits takes it out of the line at
once; a run still waiting when vibestd restarts does not start: it ends `not_started` and its creator gets a notice to
run it again. A running session takes messages as usual whatever the limit. `vibest doctor` shows the limit; a rule with
`harness` or `agent` is reported as not supported yet and is not applied, and a rule with an unknown field or a
`max` that is not a positive integer is reported as a problem and is not applied.

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
id that is not registered is refused with the registered ids listed (or, for an invalid file, its error), before any
worktree or pane is made. A session may
manage (send to, interrupt, peek at, remove) only the sessions it started.

## S60. Agents from files

A user defines an agent with one Markdown file, `~/.vibest/agents/<id>.md`: the file name is the id (lowercase letters,
digits and `-`, starting with a letter, at most 32 characters), the frontmatter holds `description` (required) and
optionally `name` (equal to the file name), `extends`, `harness`, `provider` and `model`, and the text after it is the
prompt. With `extends: <id>` the prompt is that definition's prompt, a blank line, then the file's, and that
definition's guard applies. `extends` looks at the agents registered before the files (the builtins and nothing a
config removed) and at the other files, one level only: a file named by `extends` must not extend anything itself.

```markdown
---
description: reviews a change for real bugs, each with a reproduction; changes no code
extends: general
harness: pi
provider: cpamp
model: gpt-6.2-astra
---

You are a reviewer. Read the diff of the branch you are given against main …
```

A saved file is listed by `vibest agent list` within a few seconds, without restarting vibestd, and removing it
removes the agent. `vibest run --agent <id>` starts a session with the joined prompt, and the session facts of every
new session list the agents it can start (`<id> (<description>)`, the first 20). `vibest agent show <id>` prints one
definition with its whole prompt. A session takes an edited file at its next process start, never mid-conversation.

## S61. An invalid agent file

A file that breaks a rule (a bad file name, an unknown or repeated key, no or a blank description, an empty prompt,
`provider` or `model` without `harness`, `name` unlike the file name, an `extends` that names nothing, an invalid file
or goes two levels deep) registers nothing and is reported, never dropped: under `invalid` in `vibest agent list` with its path and error, in
`vibest doctor` with the fix, and by `vibest run --agent <id>`, which is refused with that error. An invalid file whose id is a builtin's (`general.md`)
does not fall back to the builtin: starts of that agent, a plain `vibest run` included, are refused with the file's error
until it is fixed or removed. A folder that cannot be read is reported the same way, with the agents it last read kept.
The other files still load.

## S62. An agent's own harness

An agent with `harness` (and optionally `provider` and `model`) starts there when the run names no harness, instead of
the caller's harness, provider and model; a flag still wins over the file, and routing plugins run after it. `vibest ls`
names `agent:<id>` under `routing` as the decider of each field it chose. A run that names the harness takes nothing
from the file.

## S63. Replacing a builtin agent

A file whose id is a builtin's (`general.md`, `coordinator.md`) replaces it for every new start; with `extends` naming
its own id it keeps the builtin's prompt and guard and adds to them. Removing the file restores the builtin.

## S64. The entry session as another agent

`vibest --agent <id>` opens a project's entry session as that agent when it starts a new conversation (none yet, or
`--new`), on the agent's harness when no flag names one. A conversation keeps the agent it started with: bare `vibest`
reopens it as that agent, and naming another agent without `--new` is refused and changes nothing.

## S65. Agents from a plugin

A plugin registers agents with `ctx.agent.transform` (`editor.add`, and `editor.invalid` for a source it could not
read), so a user can support another file format, for example Claude Code's `.claude/agents/<name>.md`. Where the formats
differ, vibest's fields are the standard: such a plugin maps only what a definition has (`name` to the id,
`description`, the body to the prompt) and drops the rest (Claude's `tools`, its `model` aliases), and every registered
definition still passes vibest's own checks. `vibest agent
list` names the plugin that added each agent; a plugin loaded later replaces an agent of the same id.

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

## S66. Teams

`vibest run --team <name>` starts the session as a member of team `<name>` in this project. A name is lowercase letters,
digits and `-`, starts with a letter, and has at most 32 characters; any other is refused before anything starts. A
session's team is set when it is created and never changes; a session started without `--team` is in no team, even when
its creator is. The session that starts a team's first member owns the team: afterwards only it may run `--team <name>`
in this project, and any other session is refused with an error naming the owner, and nothing starts. `--team` with
`--machine` is refused.

Members of one team may `vibest send` to each other while they are unfinished (S46, S47 still refuse everyone else); a
send to an archived teammate is refused and goes to no one else. Interrupt, peek and archive stay with the session that
started each one. `vibest ls --team [<name>]` prints JSON `{team, members}`: each unfinished member's id, agent, title,
status and `startedBy`; without a name it is the caller's own team, and a session in no team gets an error. A member's
system prompt names its team and says that `vibest ls --team` lists who is in it now.

## S58. Listing worktrees

`vibest worktree list` prints JSON, grouped by project, of the worktrees vibest made for this machine's projects:
directories under its worktrees root that belong to the project. Each worktree has its path, and for each repository in
it (one, or one folder per repository in a project of several) that repository's folder, its branch or detached commit,
and its state computed then with git: dirty with the number of changed files, unsaved (commits on no branch, lost if
the worktree is removed), or clean. When git cannot read a repository, its state is unknown. The sessions whose
recorded directory is that worktree are listed with their id, title, and whether they are live or archived. Nothing is
stored and no process list is read. `--project <id|folder>` limits the list to one project; a project with no worktrees
is still printed, empty. `--machine <name>` asks that machine, which answers for its own projects. An agent may run it.
An unknown project or machine fails with its own message and prints no list.
