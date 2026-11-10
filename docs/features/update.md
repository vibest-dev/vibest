# Update and restart

How vibest updates itself and moves running agents onto a new version or another login. Each capability below says what
it is and when it counts as working.

## U1. Where the latest version comes from

`vibest update` reads the latest version from where vibest was installed: npm's registry for an npm install, the GitHub
release for an install.sh install. When that version is the running one, it says vibest is up to date and installs
nothing. A build from source says it cannot update and installs nothing.

## U2. Handing over with a Pi main agent mid-turn

`vibest update` hands vibestd over to the new version and restarts an old Pi main agent that is mid-turn, in its own
terminal: the same session, conversation and terminal, a new harness process, the interrupted turn continues, and
results still arrive.

## U3. A refused handoff leaves the old daemon serving

When the new vibest refuses the handoff before it takes over (for example, it cannot open the database), the old
vibestd keeps serving as before.

## U4. A Claude main agent updates vibest itself

A Claude main agent that runs `vibest update --yes` is restarted by vibestd in its own pane, on the same session,
conversation and terminal; it gets a notice to continue, and the update runs once.

## U5. Moving past a usage limit

When a harness hits its usage limit, only that harness ends, and the next login runs in the same pane and session; the
old process is gone and the round of work completes on the next login.

## U6. Restarting agents on an old integration

`vibest daemon restart` onto another vibest offers to restart the agents still on an old integration, and restarts them
in place: the same pane and conversation, a new harness process, and the new integration version.

## U8. Each login at most once per round

A usage-limit move tries each login at most once per round, whatever its usage reading says. When none is left, the
round ends with one failed result saying no harness is left, and nothing starts a third time in the pane.

## U9. Update to a version that cannot open the database

`vibest update` to a version that cannot open the database installs nothing: the old vibestd and install stay as they
were. After the steps its message names, the update installs.

## U10. Restart onto a version that cannot open the database

`vibest daemon restart` onto a vibest that cannot open the database stops nothing and asks nothing: the same vibestd
keeps answering. Once the database fits, a restart replaces it.
