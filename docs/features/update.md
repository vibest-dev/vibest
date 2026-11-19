# Update and restart

How vibest updates itself and moves running agents onto a new version or another login. Each capability below says what
it is and when it counts as working.

## U1. Where the latest version comes from

`vibest update` reads the latest version from where vibest was installed: npm's registry for an npm install, the GitHub
releases for an install.sh install. It follows the channel of the running version: a stable vibest (`x.y.z`) takes the
newest stable release, a beta (any other version) the newest release of either channel, beta or stable; `--stable` and
`--beta` choose the channel instead, and both together are refused. When the chosen version is not newer than the
running one, it says vibest is up to date, names the newest release of that channel when it differs, and installs
nothing. A build from source says it cannot update and installs nothing.

It says within a second that it is checking for a newer version, then one line per stage as it happens: downloading
(with the size and progress when the source gives a size), checking that the new version runs and opens the database,
installing, and handing vibestd over or restarting it. It downloads the new version once: the copy it checked is the
one it installs, and no stage has a time limit.

## U2. Handing over with a Pi entry session mid-execution

`vibest update` hands vibestd over to the new version and restarts an old Pi entry session that is mid-execution, in its own
terminal: the same session, conversation and terminal, a new harness process, the interrupted execution continues, and
messages still arrive.

## U3. A refused handoff leaves the old daemon serving

When the new vibest refuses the handoff before it takes over (for example, it cannot open the database), the old
vibestd keeps serving as before.

## U4. A session does not update vibest

`vibest update` run by a session, the entry session included, is refused as the user's command; nothing is installed or
restarted and the session keeps running.

## U5. Moving past a usage limit

When a harness hits its usage limit, only that harness ends, and the next login runs in the same pane and session; the
old process is gone, the limited execution ends failed, and the next login gets the same input in a new execution that completes
the work.

## U6. Restarting agents on an old integration

`vibest daemon restart` onto another vibest offers to restart the agents still on an old integration, and restarts them
in place: the same pane and conversation, a new harness process, and the new integration version.

## U8. Each login at most once for one input

A usage-limit move tries each login at most once for one input, across the executions its limits moved it through, whatever
its usage reading says. When none is left, an execution of its own ends failed with one notice saying no harness is left, and nothing starts a third time in the pane.

## U9. Update to a version that cannot open the database

`vibest update` to a version that cannot open the database installs nothing: the old vibestd and install stay as they
were. After the steps its message names, the update installs.

## U10. Restart onto a version that cannot open the database

`vibest daemon restart` onto a vibest that cannot open the database stops nothing and asks nothing: the same vibestd
keeps answering. Once the database fits, a restart replaces it.

## U11. An update from an older protocol restarts the agents

One `vibest update` run by an older vibest on an older protocol ends with the agents on the old integration restarted
by the vibest it installed: the old vibest exits 0, and the entry session and the subagent keep their session and
conversation with a new harness process.

## U13. Installing a channel

`install.sh` installs the newest stable release; when there is none it installs nothing and its message names
`--beta`. `install.sh --beta` installs the newest release of either channel, beta or stable. Checked by
`packages/cli/test/install-sh.test.ts` against a release list on disk.

## U12. This vibest replaces an older-protocol daemon

One `vibest update` run by this vibest, while vibestd is an older vibest on an older protocol, hands that vibestd over
even when an agent's execution end lands while it drains, and restarts the agents on the old integration: the entry session and
the subagent keep their session and conversation with a new harness process, and the new vibestd is no child of a
vibest process.
