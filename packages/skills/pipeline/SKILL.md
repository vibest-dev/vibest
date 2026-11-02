---
name: pipeline
description: Plan, implement, review, then open a pull request, with the user approving the plan first. Only vibest's main agent (the coordinator) starts agents; a subagent must not use this skill. Use when the user wants a plan or design before code, a review before merging, or a pull request at the end ("plan it first, then build it", "write a design, then implement", "implement it and have someone review it", "先出方案再写，写完找人 review 后提 PR", "do it as a pipeline", "/pipeline").
---

# Pipeline

Plan → the user agrees → implement → review until the reviewer approves → pull request. Follow delegate: do not poll; each result arrives by itself; check it yourself. The user stays in the loop and may step into any pane. What they say overrides the next step.

## 1. Plan

```
vibest run <harness> -- 'Write an implementation plan for: <goal, paths, constraints>. Read the code. Report the approach, the files to change, the steps, how to verify, and open questions. Do not modify files.'
```

Its id is <planner id>. Tell the user the plan is being written and end your turn. Do not pass `--archive-on-completion`: the user has not agreed yet, and a completed result would archive the session before they can answer.

## 2. Agree

Show the plan in full, including open questions. Do not implement until the user agrees. If they change it, `vibest send <planner id> -- '<their changes>'` while the planner is open, or edit the plan text yourself before you save it. When the text is agreed, `vibest archive <planner id>`. The agreed text is the plan.

## 3. Implement

```
vibest project write scratch pipeline-<topic>-plan.md --if-version new -- '<the agreed plan, verbatim>'
vibest run <harness> -- 'Implement the plan at <absolute scratch path> exactly. Run the tests and typecheck, commit on a branch, push, and report the branch and hash. Do not open a pull request.'
```

Its id is <implementer id>. The absolute path is `scratchPath` from `vibest project info`, plus the file name. If write says the file already exists, `vibest project read scratch pipeline-<topic>-plan.md`, then write again with the version it prints, or pick a new file name. Do not pass `--archive-on-completion`: this session stays for review and the pull request. When it reports, check the diff and the tests yourself before review.

## 4. Review

`--peer` shares the implementer's worktree: a pane split off the implementer's pane. Archiving the reviewer never removes that worktree.
Read-only here is the prompt you pass, plus the peer git rule the session already has: no commit, and nothing that moves HEAD, a branch, or the index.

```
vibest run <harness> --peer <implementer id> -- 'Review the change on this branch against the plan at <absolute scratch path>. Run git diff main...HEAD. Do not modify files, commit, or move HEAD. Look for bugs, missing tests, and departures from the plan; run the tests. Start with "verdict: approve" or "verdict: changes requested", then each comment with file and line.'
```

Its id is <reviewer id>. Do not pass `--archive-on-completion`: later rounds go to this reviewer with `vibest send`.

## 5. Until approval

- `changes requested` → `vibest send <implementer id> -- '<the comments, verbatim. Fix them, run the tests, commit, push, and report the hash.>'` When it reports, `vibest send <reviewer id> -- 'The implementer pushed <hash>. Review again. Same report format.'`
- `approve` → open the pull request.
- After 3 rounds without approval, or a judgment call, stop and show the open comments. The user decides: another round, accept, or change the plan.

One line to the user per round: the number, the verdict, what is being fixed.

## 6. Pull request

```
vibest send <implementer id> -- 'The review approved the change. Open a pull request against main with gh pr create. Title: <title>. Body: the plan, the change, and how it was verified. Report the URL.'
```

Give the user the URL. Then `vibest archive <reviewer id>`. Keep the implementer until the user is done; follow-ups are `vibest send <implementer id> -- '<message>'`.
