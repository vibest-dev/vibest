# Machines

One machine's vibestd (A) can run agents on another machine (B) over ssh. Design:
[multi-machine.md](../design/multi-machine.md). Each capability below says what it is and when it counts as working.

## M1. Adding a machine and running on it

`vibest machine add` records B, B records A as a peer, and a second name for the same B is refused. `vibest run
--machine`, run by A's entry session, starts a session on B and none on A; A's entry session gets one message from `<machine>/<id>` with what the session sent, and nothing stays
waiting on B. `send`, `result`, `peek`, `ls` and `archive` reach the session on B. Each checkout is known by one remote, chosen the same way on
both machines (the GitHub CLI default, then `upstream`, then `origin`, then the others by name; network URLs only),
and the same repository matches across URL forms and ssh aliases for any host; a checkout with no such remote is refused
naming it.

## M8. A remote execution end sends nothing

When an execution ends on B without the session sending anything, B queues nothing for A, A's entry session gets no notice, and
`vibest result <machine>/<id>` on A returns the execution's reply.

## M2. Messages survive a lost connection

A message sent while A's vibestd is stopped, and one sent while the ssh connection is down, each arrive once;
meanwhile `vibest ls` shows the machine as not connected.

## M3. Two machines on one B

Two machines using the same B are two peers, and each gets only its own messages and sessions. A session on A
reaches on B only the sessions it started, and B refuses a forwarded call that does not say whether the user or a session
made it, and a `vibest run --machine` that no session made.

## M4. Removing and re-adding a machine

`vibest machine rm` while a task is open, then adding B again under another name, delivers the message once.

## M5. Clear failures

An unknown machine, vibest missing on the target, ssh failing, the target being this vibestd, a different vibestd
behind the target, a commit the target does not have, and agents running `connect` or `machine add`: each fails with its
own message.

## M11. A project of several repositories on another machine

`vibest run --machine` from a project of several repositories (a folder of git repositories) starts the session in B's
one project that holds exactly those repositories, in one worktree with A's folder names, each repository detached at
A's commit. B lacking one of the repositories is refused naming it and `vibest project add`; B lacking a commit is
refused naming the checkout and the commit; several such projects on B are listed and refused; nothing is started
for a refused run. A single-repository project runs as in M1.

## M12. A B too old for several repositories

A `vibest run --machine` from a project of several repositories to a B whose vibest does not take a repository list is
refused on A with `run vibest update on <B>`; B starts nothing.

## M13. Choosing B's project

When B has several projects holding A's repositories, `vibest run --machine` is refused listing each with its id and
folder and saying to pass `--project`. `vibest run --machine <B> --project <id, id prefix or folder name>` runs in
that project, which must still hold exactly A's repositories at A's commits.

## M9. Listing another machine's harnesses

`vibest harness ls --machine <name>` prints the harnesses of that machine in the shape of the local list, asked of that
machine's vibestd each time, so a plugin only B has shows up; an agent can run it. An unknown machine and a machine that
is not connected fail with their own message and print no list.

## M6. B's herdr-core terminals on A

Adding a machine shows B's herdr-core terminals in A's herdr-core: a session on B is addressed by its terminal on A;
typing there starts an execution on B whose message arrives once; a rename is followed; a removed terminal comes back with the
next `vibest ls`; `vibest machine rm` removes them.

## M10. How loaded a machine is

`vibest status` gives this machine's load, and `vibest machine ls` gives each added machine's under `load`: usable cores, the share of CPU in use over a 200 ms sample, total memory and the memory the OS can hand out without swapping (on macOS free, inactive and speculative pages, not free alone; on Linux MemAvailable; a cgroup cap counts on Linux), and how many executions are working on that machine. Another machine is asked of that machine's vibestd, which measures itself. A machine that cannot be read has no `load` and says why in `loadError`; it never shows as idle. `vibest status` leaves `load` out when this vibestd cannot read it or does not answer within a second. On Linux the reading is what the tightest limit from vibestd's own cgroup up to the root and its CPU affinity allow, with reclaimable page cache counted as available. Nothing is stored and nothing is read on a timer; a reading is reused for 5 seconds.

## M7. B's herdr sessions on A

`vibest run --machine`, run by a session on A, opens in B's default herdr session (`default`), which `vibest machine add` saves on A and which
still works after B's vibestd restarts it; a plain herdr server on B is refused with a note to restart it; a prompt
typed there gives one message notice; `vibest ls` adds a removed entry back and `vibest machine rm` removes it.
