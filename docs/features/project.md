# Projects

Each repository (or directory of repositories) is a Project with its own folder of knowledge (`VIBEST_PROJECT_DIR`):
`preferences.md`, `docs/`, `memories/`, and `artifacts/` (reserved strictly for human-facing deliverables: agreed
`pipeline` plans, UI mockups, diagrams, acceptance reports, explicit user-requested reports). Each Project also gets a
shared temporary scratchpad (`VIBEST_SCRATCHPAD_DIR`, under `<os.tmpdir()>/vibest-<uid>/<project-id>/scratchpad`,
left in OS temp after `vibest archive` so parent agents and users can still inspect it) for temporary agent-to-agent
handoffs, `--file` briefs, review notes, repro scripts, and scratch files (prefixed with each session's 8-char id so
parallel sessions never collide). Each capability below says what it is and when it counts as working.

## P1. Project info

`vibest project info` in a repository prints the Project's folder and the paths of its subfolders.

## P2. Project search

`vibest project search` searches the Project's docs, memories and artifacts and prints each hit as kind, path, line and
text.

## P7. A moved checkout

`vibest project move <old-directory>`, run inside the repository at its new place, moves the Project recorded at the
old directory there: the same Project, with its new path, its memories, its sessions and the worktrees vibest made
still working. vibest never detects a move itself: `vibest` at an unknown place is a new Project. The command is
refused, changing nothing, when no Project is recorded at the old directory, when a Project is already recorded here,
or when the old directory still exists. An agent may not run it.

## P8. Agents use the Project folder and receive the curated memory index

A Pi entry session, a Pi subagent and a Claude subagent each write and read the Project's artifacts with their own file
tools, without a permission prompt. Every Claude session also has all of Bash pre-approved (a rule the user sets to ask
for Bash still asks). Custom path boundaries (such as refusing writes outside `VIBEST_PROJECT_DIR`) can be enforced by a user `session.tool.execute.before` plugin (G21). Every session's system prompt carries
`preferences.md` and the curated memory index `memories/MEMORY.md` (capped at 100 lines and 8,000 bytes on a line
boundary, with a warning when truncated to compact under 70 lines; bootstrapped once newest-first up to 70 lines and
5,600 bytes when `MEMORY.md` is missing and `memories/` holds `.md` files), while topic file bodies in
`memories/<name>.md` and unindexed topic files stay out of the prompt and are read on demand or searched with
`vibest project search <query> --kind memories`. Saving or updating a memory maintains both `memories/<name>.md` and
its one-line entry in `memories/MEMORY.md`, updating or removing stale entries instead of only appending.

## P9. Creating a Project

`vibest project create` makes a Project through vibestd, from relative paths too: both folders exist afterwards. An
agent may not create one, and a directory that is not empty is kept as it was.

## S14. Several repositories

Each repository is its own Project, and the same one wherever you stand in it: a subdirectory or a linked worktree of a
repository is that repository's Project, while a nested repository and another clone of the same origin are other
Projects. Agents started in two repositories at once each work in a worktree of their own repository (a nested
repository is not copied into it), each result belongs to its own run, and neither run is listed in the other
repository.

## S37. Listing outside a project

`vibest ls` outside any project lists the sessions of every project. In a git repository that is no Project it lists
nothing, and the CLI runs no git to find that out.
