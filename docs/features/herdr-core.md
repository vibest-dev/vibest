# herdr-core runtime

Agents can run in herdr-core terminals instead of herdr panes. Each capability below says what it is and when it counts
as working.

## S33. Agents in herdr-core

A Pi entry session and its sessions run in herdr-core: results and sends go both ways, status shows, and herdr-app labels
each terminal with its project and task and shows which session started which.

## S34. Starting in the user's own terminal

`vibest --runtime hc` typed in a terminal of the user's own herdr-core starts the entry session in place, in that terminal.

## S35. herdr-core without naming it

`vibest` in a herdr-core terminal, without `--runtime`, starts the entry session there, and its sessions start there too;
`vibest run --runtime herdr` places a session in herdr instead.

## S59. A harness that exits at once

A session's harness in herdr-core starts after the user's shell configuration, and the terminal returns to the user's
shell when it exits. When it exits before it was ready, its creator is told at once, with the last lines of its terminal,
instead of after the ready timeout.

## S36. Unwatched execution ends

A session execution that ended while nobody watched shows as done, for the session and its project; once it is seen, it is
idle.
