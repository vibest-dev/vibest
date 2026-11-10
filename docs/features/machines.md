# Machines

One machine's vibestd (A) can run agents on another machine (B) over ssh. Design:
[multi-machine.md](../design/multi-machine.md). Each capability below says what it is and when it counts as working.

## M1. Adding a machine and running on it

`vibest machine add` records B, B records A as a peer, and a second name for the same B is refused. `vibest run
--machine` starts a session on B and none on A; A's main agent gets one notice with B's result, and nothing stays
waiting on B. `send`, `result`, `peek`, `ls` and `archive` reach the session on B.

## M2. Results survive a lost connection

A result written while A's vibestd is stopped, and one written while the ssh connection is down, each arrive once;
meanwhile `vibest ls` shows the machine as not connected.

## M3. Two machines on one B

Two machines using the same B are two peers, and each gets only its own results and sessions.

## M4. Removing and re-adding a machine

`vibest machine rm` while a task is open, then adding B again under another name, delivers the result once.

## M5. Clear failures

An unknown machine, vibest missing on the target, ssh failing, the target being this vibestd, a different vibestd
behind the target, a commit the target does not have, and agents running `connect` or `machine add`: each fails with its
own message.

## M6. B's herdr-core terminals on A

Adding a machine shows B's herdr-core terminals in A's herdr-core: a session on B is addressed by its terminal on A;
typing there starts a turn on B whose result arrives once; a rename is followed; a removed terminal comes back with the
next `vibest ls`; `vibest machine rm` removes them.

## M7. B's herdr sessions on A

`vibest run --machine` opens in B's default herdr session (`default`), which `vibest machine add` saves on A and which
still works after B's vibestd restarts it; a plain herdr server on B is refused with a note to restart it; a prompt
typed there gives one result notice; `vibest ls` adds a removed entry back and `vibest machine rm` removes it.
