# No Background Polling

vibestd learns what changed from events, not by looking again on a clock.

1. No background loop may scan state on an interval: no `Effect.forever` or `Effect.repeat(Schedule.…)` over sessions, rows or runtimes, no `setInterval`. A change reaches vibestd as an event (a commit on the Bus, a runtime's `events`, a hook); what no event reported while vibestd was down or a runtime was away is found once, by the reconcile at start and on a runtime's reset.
2. Allowed: a bounded wait inside one operation (`awaitEvent`, or `Effect.repeat({ until, schedule })` under a timeout), a retry after a failure, a client's reconnect loop, a blocking take from a queue, and one-shot timers (`engine.arm`) that fire once and are re-armed by the event they wait for.
3. A runtime must push `events`; core never polls `process` to find an exit.
4. Exception approved by the owner: vibestd looks up the latest vibest at start and then every hour (`packages/core/src/update-check.ts`), keeping the answer in memory only.

Status: in force on `feat/event-driven`. `tools/check/no-background-loop.test.ts` greps `packages/core/src` and `packages/server/src` for these shapes; a hit fails unless its allowlist names it with a reason. The client, CLI, integration and runtime packages are not scanned: their reconnect loops are allowed.
