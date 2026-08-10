# Recover interrupted turns with a durable acknowledgement barrier

## Context

A server process can stop after a harness accepted a prompt but before Vibest
observed a terminal turn event. The replacement process has a new session
stream and can read whatever conversation history the harness committed, but it
cannot prove whether the old execution stopped before or after running tools.

The current harness `resume` operations restore conversation context for future
prompts. They do not attach to the same in-flight executor, replay its native
event cursor, or recover pending permission callbacks. Reissuing the prompt can
therefore repeat file writes, commands, network calls, or other non-idempotent
tool effects.

Treating the replacement session as idle is also unsafe: a client-local Queue
can immediately send its next prompt before committed history is reconciled,
while the user has no indication that the previous result is unknown.

## Decision

Before a session prompt is published or sent to a harness, Vibest writes a
separate durable recovery record containing the server boot id and every prompt
whose turn has not reached a known terminal event. Prompt acceptance correlates
each prompt with its turn. Terminal and rejection events update or remove only
the prompts they account for.

On a later server boot, any unresolved record owned by the previous boot becomes
a **Recovery barrier**:

- snapshots and status report `recovery_required`;
- committed harness history remains readable;
- no old prompt is replayed;
- no queued or newly entered prompt is sent;
- stale pending requests are not restored as actionable;
- the user is shown every uncertain prompt and must explicitly acknowledge the
  unknown outcome before future work may run.

Acknowledgement is compare-and-set by recovery id and is broadcast as a session
event. It means only that the user reviewed the available history and accepts
starting future work. It does not assert that the old turn completed, failed,
was interrupted, or had no side effects.

Recovery records live separately from session identity metadata. This keeps
runtime checkpoint writes from racing title/archive updates and lets corrupt
recovery data fail closed without making ordinary metadata unreadable.

## Rejected alternatives

### Automatically replay the prompt

Rejected because the old process may already have executed tools. None of the
current harnesses provides exactly-once prompt or tool semantics.

### Treat adapter resume as active-turn continuation

Rejected because adapter resume opens the persisted conversation for future
work; it does not attach to the original running executor or recover its pending
callbacks.

### Mark every interrupted turn failed and continue the Queue

Rejected because a failure label does not resolve whether side effects occurred,
and continuing automatically can run dependent prompts against an unknown
workspace state.

### Persist the old stream id and cursor

Rejected because the old process's event sequence and buffers no longer exist.
The replacement process must use a new stream generation.

## Consequences

- Server restarts are fail-closed for unresolved turns.
- Native history may restore some or all committed output, but cannot synthesize
  a final assistant reply that the harness never persisted.
- A history read may start a harness context process for adapters without a cold
  history reader; it still sends no prompt while the barrier exists.
- Tool side effects that occurred before the crash remain possible and unknown.
- Actual active-turn continuation remains a future adapter capability requiring
  attach-only ownership, durable native turn identity, event replay, and pending
  request recovery.
