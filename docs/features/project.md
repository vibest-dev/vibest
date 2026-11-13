# Projects

Each repository (or directory of repositories) is a Project with its own folder of knowledge: preferences, docs,
memories and artifacts. Each capability below says what it is and when it counts as working.

## P1. Project info

`vibest project info` in a repository prints the Project's folder and the paths of its subfolders.

## P2. Project search

`vibest project search` searches the Project's docs, memories and artifacts and prints each hit as kind, path, line and
text.

## P7. A moved checkout

When a Project's checkout has moved, `vibest` there asks whether to move the Project; answering yes keeps the same
Project, with its new path, its memories, and worktrees that still work.

## P8. Agents use the Project folder with their file tools

A Pi entry session, a Pi subagent and a Claude subagent each write and read the Project's artifacts with their own file
tools, without a permission prompt. Every Claude session also has all of Bash pre-approved (a rule the user sets to ask
for Bash still asks). Writing into another Project's folder is refused.

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
