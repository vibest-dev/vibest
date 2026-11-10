# herdr-core runtime

Agents can run in herdr-core terminals instead of herdr panes. Each capability below says what it is and when it counts
as working.

## S33. Agents in herdr-core

A Pi main agent and its sessions run in herdr-core: results and sends go both ways, status shows, and herdr-app labels
each terminal with its project and task and shows which session started which.

## S34. Starting in the user's own terminal

`vibest --runtime hc` typed in a terminal of the user's own herdr-core starts the main agent in place, in that terminal.

## S35. herdr-core without naming it

`vibest` in a herdr-core terminal, without `--runtime`, starts the main agent there, and its sessions start there too;
`vibest run --runtime herdr` places a session in herdr instead.

## S36. Unwatched turn ends

A session turn that ended while nobody watched shows as done, for the session and its project; once it is seen, it is
idle.
