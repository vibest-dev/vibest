# vibestd State

vibestd is a long-running daemon, so it keeps little in memory.

1. State that must survive a restart, or grows with sessions or rows, lives in sqlite and is read when needed: integration versions, harness pids, launch records, pending rows.
2. Memory holds only small bounded things: per-project locks, one-shot timers (a polling entry session's away timer, a lease's end, a session's execution-end checks), open connections, and state that must not outlive the vibestd that made it: poll leases (a vibestd that starts puts the leased rows back to pending, `Db.recoverDelivering`) and the restarting mark of a restart in place (`Restarting`).
3. Per-project locks are in process, not in sqlite: the locked work waits on the runtime, and a lock row would outlive a crash. An entry is removed when it is released and nobody waits on it. `keyedLock` counts holders and waiters itself, because the semaphore does not expose its waiters: an entry dropped while one waits would give the next caller a second lock for the same key.
4. No caches of sessions, results or message text. No per-request history.
5. No map that grows with sessions or rows, unless its entries go when the session ends.

Status: decided. Main breaks it in two places: `packages/core/src/sessions.ts` keeps `tracked`, a map from session id to its lock and flags (`endedAt`, …) that is never pruned (5); `packages/core/src/inbox.ts` keeps `locks`, one semaphore per project that is never removed (3). The models list cache in `packages/core/src/harness.ts` (per harness and provider, TTL) holds no sessions, results or text and is bounded.
