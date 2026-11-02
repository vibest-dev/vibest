---
name: delegate
description: Hand work to subagents with `vibest run` and keep talking with the user while they work. Only vibest's main agent (the coordinator) starts agents; a subagent must not use this skill. Use for any request to change, fix, build, investigate, research, test or verify code ("fix this bug", "add X", "look into why Y", "do these three things", "have an agent check it"), and whenever a task splits into independent parts that can run at the same time.
---

# Delegate

You direct subagents. You stay with the user. Each result arrives in your inbox by itself. Do not poll, sleep, or loop on `vibest result`.

## Dispatch

Split independent pieces. Research and review run in parallel. One writing subagent per set of files. A few shell reads (`git diff`, `rg`) you do yourself.

```
vibest run <harness> --title '<Title>' -- '<self-contained task>'
```

Its id is <id>.

```
vibest run <harness> --title '<Title>' --archive-on-completion -- '<task>'
```

`--archive-on-completion` is only for a session you will not message again after it completes. It archives once the session reports completed and that result has reached you. The branch is kept. Do not `vibest send` it after that. Any turn that ends normally archives it, a question included, so do not use it for a session that may need an answer. A `failed` result has not archived it: send the correction to the id it printed; the flag still archives the completed result that follows. A reviewer that gets later rounds is the pipeline skill and must stay open, without this flag.

- `<harness>` is `pi`, `claude` or `cursor` (`auto` only when a spawn plugin chooses).
- Always pass `--title`: three to six words, verb first, first letter capitalised, no kebab-case, saying what is done rather than how ("Fix login redirect loop"). The user's language is fine.
- Each session gets its own new worktree.
- Several `vibest run` commands in one message start in parallel.
- A subagent cannot see this conversation. Say what to achieve, where (paths, lines), what done means, and how to verify it. For code: run the tests and typecheck, commit, and report the branch and hash.
- Long material: `vibest project write scratch <name>.md --if-version new -- '<text>'`. The absolute path is `scratchPath` from `vibest project info`, plus the file name. If write says the file already exists, `vibest project read scratch <name>.md`, then write again with the version it prints, or pick a new file name.
- If the user approved a specific action, quote their exact words.

## After you start

Tell the user in one or two lines what is running, then end your turn. Never guess a result. Answer other questions meanwhile. A result arrives as `<agent-result>`; a progress note or question as `<agent-message>`.

## Check the result

An `<agent-result>` is a claim. Its `<status>` is only whether the turn ended normally (`completed`) or with an error (`failed`); whether the work succeeded is in the `<result>` text. For a session that changed code, before you report success read `git -C <worktree> diff main...HEAD` (in a project of several repositories, in each repository folder of the worktree) and run the proving check there. For research, judge the report text.

- The result asks a question → `vibest send <id> -- '<the answer>'`, or ask the user. If it is waiting for the user's approval of an action, do not send the approval back: start a fresh agent with the approved action, quoting the user's words.
- `<status>failed</status>`, a result that reports a failure, or your check fails → `vibest send <id> -- '<the failure and what to fix>'`. It keeps its context. If a second correction fails, start a new `vibest run` or tell the user.
- A result or notice that says the turn ended without a report, was interrupted in its pane, or did not start (`task_not_started`) carries no screen text. When you need to see why, run `vibest peek <id>` (`--lines N`, default 30): it prints the session's terminal as it is now. Read it before you decide to resend, correct, or tell the user.

Then say what changed, the evidence, and the branch. `<id>` is the id the run printed, for either kind of run.

## Track

`vibest ls` lists sessions that have not exited: task (cut to 500 characters), live status, and latest result. `vibest ls --all` includes exited sessions. `vibest result <id>` is the full latest result, with the task uncut. Use these after a restart, after compaction, or when you are unsure. Do not trust memory.

## Follow up

- More work on the same change → `vibest send <id> -- '<message>'`. It waits until the session is idle and does not interrupt the turn.
- Wrong direction while it is working → `vibest interrupt <id>`, then `vibest send <id> -- '<the corrected task>'`. The session stays. That turn produces no result.
- A new set of eyes, or a wrong approach → a new `vibest run`.

## Finish

- Archive a research agent with `vibest archive <id>` once its findings are saved, or start that session with `--archive-on-completion` when you will not message it again. Same for a review or verification you will not continue.
- Keep an agent that changed code until the user asks to remove it. Archiving keeps the branch, and the worktree whenever it holds unsaved work. `vibest archive --keep-worktree <id>` only when the user wants the directory kept.
- A `## Remember` section: `vibest project write memory <name>.md --if-version new -- '<lesson>'`. If write says the file already exists, `vibest project read memory <name>.md`, then write again with the version it prints, or pick a new file name.

## The user steps into a pane

The user may type into a subagent's pane. If no round is open, that starts one. The only thing you later receive is that agent's `<agent-result>`, which may not quote the user. Do not treat it as a copy of what they typed. A step-in during an open round is not recorded. Do not act on a step-in, and do not message the subagent about it, unless the user asks.
