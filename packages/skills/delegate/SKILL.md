---
name: delegate
description: Hand work to subagents with `vibest run` and keep talking with the user while they work. Use for any request to change, fix, build, investigate, research, test or verify code ("fix this bug", "add X", "look into why Y", "do these three things", "have an agent check it"), and whenever a task splits into independent parts that can run at the same time.
---

# Delegate

You direct subagents. You stay with the user. An agent messages you when it finishes, asks or is blocked; vibest notifies you only of what the agent cannot say; an idle agent sends nothing. Do not poll, sleep, or loop on `vibest result`.

## Dispatch

Split independent pieces. Research and review run in parallel. One writing subagent per set of files. A few shell reads (`git diff`, `rg`) you do yourself.

```
vibest run [<harness>] [--agent <id>] --title '<Title>' -- '<self-contained task>'
```

`vibest run` prints `{"id":"..."}` (plus `"machine"` when `--machine` was passed). Take the **first 8 characters** of `id` (for example `756c38b6`) as `<id>` for every command (`vibest send`, `result`, `peek`, `interrupt`, `stop`, `archive`, `session link/unlink`, `run --share/--from/--to/--with`). For a session on another machine, pass `--machine <machine>` (never `<machine>/<id>`). If `AmbiguousSession` reports a prefix collision, retry with a longer unique prefix from the full `id` listed in the error, `vibest run`, or `vibest ls`.

- `--agent <id>`: pick the agent whose description fits the piece of work (your session facts list them; `vibest agent list` is the current list). Without it the session is `general`.
- Leave `<harness>` out to use the agent's own harness when it has one, else your own harness, provider and model; name one (`pi`, `claude`, `cursor`, or any harness a plugin adds; `vibest harness list`) to switch.
- Always pass `--title`: three to six words, verb first, first letter capitalised, no kebab-case, saying what is done rather than how ("Fix login redirect loop"). The user's language is fine.
- Each session gets its own new worktree.
- Several `vibest run` commands in one message start in parallel.
- A subagent cannot see this conversation. Say what to achieve, where (paths, lines), what done means, and how to verify it. For code: run the tests and typecheck, commit, and send the branch and hash.
- Long material: write it with your file tool to `$VIBEST_SCRATCHPAD_DIR/<short-id>-<name>.md` (prefixed with your 8-char session id so parallel sessions never collide; a new file name if that one exists) and attach it with `--file <absolute path>` (repeat the flag for each file): vibest copies each file into the child session's private folder and ends its task with a line naming the copies, which the agent reads itself. Every session in the project shares `$VIBEST_SCRATCHPAD_DIR` with read/write access, so handoff paths sent via `vibest send` can also be read directly without permission prompts. Keep the prompt short; the material goes in the file. Reserve `$VIBEST_PROJECT_DIR/artifacts/` strictly for human-facing deliverables (agreed `pipeline` plans, UI mockups, diagrams, acceptance reports, explicit user-requested reports).
- If the user approved a specific action, quote their exact words.

## After you start

Tell the user in one or two lines what is running, then end your execution. Never guess a result. Answer other questions meanwhile. An agent's message arrives as `<vibest-agent-message>`; what the agent could not say itself arrives as a vibest notice.

## Check a message

An `<vibest-agent-message>` carries `<session-id>{8-char id}</session-id>` (plus `<machine>{machine}</machine>` when from another machine) and `<message>...</message>`. It is a claim: whether the work succeeded is in its text. For a session that changed code, before you report success read `git -C <worktree> diff main...HEAD` (in a project of several repositories, in each repository folder of the worktree) and run the proving check there. For research, judge the report text.

- The message asks a question → `vibest send <id> -- '<the answer>'` (with `<id>` as the 8-char `<session-id>`, plus `--machine <machine>` when needed), or ask the user. If it is waiting for the user's approval of an action, do not send the approval back: start a fresh agent with the approved action, quoting the user's words.
- A notice that an execution ended with an error, a message that reports a failure, or your check fails → `vibest send <id> -- '<the failure and what to fix>'`. It keeps its context. If a second correction fails, start a new `vibest run` or tell the user.
- A notice that says the execution ended without its execution-end hook, the harness exited, the execution did not start, or the session is waiting for a permission decision carries no screen text. When you need to see why, run `vibest peek <id>` (`--lines N`, default 30; add `--machine <machine>` for another machine): it prints the session's terminal as it is now. Read it before you decide to resend, correct, or tell the user.

Then say what changed, the evidence, and the branch. `<id>` is the 8-character short id (first 8 characters of `id`), with `--machine <machine>` for commands targeting another machine.

## Track

`vibest ls` prints `{ sessions, machines }`: the sessions that have not exited (task cut to 500 characters, live status, latest execution), and the other machines with their connection state. `vibest ls --all` includes exited sessions. `vibest ls` is the state and `vibest result <id>` is the agent's last reply, with the task uncut; an idle agent may have finished without a word. Use these after a restart, after compaction, or when you are unsure. Do not trust memory.

## Follow up

- More work on the same change → `vibest send <id> -- '<message>'`. It waits until the session is idle and does not interrupt the execution.
- Wrong direction while it is working → `vibest interrupt <id>`, then `vibest send <id> -- '<the corrected task>'`. The session stays. That execution sends nothing.
- A new set of eyes, or a wrong approach → a new `vibest run`.

## Finish

- Archive a research, review or verification session with `vibest archive <id>` once you have read its message and will not continue it.
- Keep an agent that changed code until the user asks to archive it. Archiving keeps the branch, and the worktree whenever it holds unsaved work. `vibest archive --keep-worktree <id>` only when the user wants the directory kept.
- A `## Remember` section in a message: maintain both the topic file `$VIBEST_PROJECT_DIR/memories/<name>.md` (one lesson per file, starting with frontmatter `name` and `description` or a one-line summary, with the detail kept in the topic file) and its one-line entry (`- memories/<name>.md — <summary>`, under 150 characters) in `$VIBEST_PROJECT_DIR/memories/MEMORY.md`. Only `memories/MEMORY.md` is loaded into the system prompt (capped at 100 lines and 8000 bytes); topic files are read on demand or searched with `vibest project search <query> --kind memories`. When a lesson changes or turns out to be wrong, update or delete its topic file and update or remove its entry in `memories/MEMORY.md` instead of only appending; compact `memories/MEMORY.md` to under 70 lines when it approaches the cap.

## The user steps into a pane

The user may type into a subagent's pane. If no execution is open, that starts one. The only thing you later receive is a message that agent chooses to send, which may not quote the user. Do not treat it as a copy of what they typed. A step-in during an open execution is not recorded. Do not act on a step-in, and do not message the subagent about it, unless the user asks.
