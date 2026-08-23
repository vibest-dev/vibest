# Pi history folds by user-entry segmentation; live matches it (amended)

Pi session history (`session.getMessages`) is folded from the agent's native
`SessionEntry` branch by **role**: every `user` message entry opens a new
message, and all `assistant`/`toolResult` entries up to the next `user` entry
collapse into a single assistant `UIMessage`. Message ids are the entry id of
the segment's first assistant entry (assistant messages) or the user entry id
(user messages).

> **Amended 2026-08-02.** The original decision accepted that a steered
> conversation renders as more messages after a refresh than it did live. A
> probe of `pi --mode rpc` disproved the premise: a delivered steer _is_
> visible on the live wire as `message_start role=user` (full content), at
> exactly the position of the persisted `user` entry. The live transform now
> splits its UIMessage on that marker, so live and history segmentation agree.
> The superseded text below is kept for the reasoning that still stands.

## Context

- Pi persists sessions as an append-only entry tree (`~/.pi/agent/sessions/`),
  read over pi's RPC mode via `get_entries` — which returns the **full** entry
  set plus `leafId`; the current branch is reconstructed by walking `parentId`
  from `leafId`. Entry ids are stable across reads (verified against the live
  binary).
- Pi's `steer` and `follow_up` RPC commands inject the new user input as a
  **regular `user` entry** mid-run, closing the current assistant message and
  starting a new turn inside the same agent run (verified: both commands
  produce identical on-disk chains `user → assistant → user → assistant`).
- Our live transform (`packages/server/src/harness/pi/transform.ts`) opens one
  UIMessage per agent run (`agent_start` → `agent_settled`) and does not split
  on pi's internal `turn_end`/`turn_start` (correctly — see Consequences).
  Since the 2026-08-02 amendment it _does_ split on a delivered steer's
  `message_start role=user`. The vibest pi adapter
  (`packages/server/src/harness/pi/agent.ts:421`) issues `steer` when a prompt
  arrives while a turn is active, so this occurs in production today.
  (`docs/wayfinder/session-streaming-refactor/map.md` still lists steer as
  out-of-scope/rejected — the code has since moved past that note.)
- Alternative segmentation by `stopReason` was rejected: the terminal-reason
  vocabulary (`toolUse`, `stop`, `error`, `aborted`) is open-ended and
  auto-retry can produce several terminal reasons inside one logical turn.
  User-entry boundaries are the harder fact.

## Decision

1. Segment by role as described above; ids come from entry ids so refresh
   reconciliation can compare stably.
2. ~~Keep the live transform untouched.~~ **Amended:** the live transform
   splits on a mid-run `message_start role=user` — the wire marker of a
   delivered steer — closing the open UIMessage and starting a fresh one. The
   echo of the _prompting_ input (which also arrives as
   `message_start role=user`, but before any assistant output) is still
   skipped. Verified against the live binary (2026-08-02 probe): RPC mode
   emits `message_start` per message; the `assistantMessageEvent` `start`
   delta never appears on this wire, so the per-message block ordinal advances
   on `message_start role=assistant` too.
3. ~~Accept that a steered conversation re-segments on refresh.~~ **Amended:**
   live and history now segment identically (same count, same boundaries).
   Ids still differ (live: generated uuids; history: entry ids) — refresh
   reconciliation remains id-replacing, not id-stable.
4. Parity ("对拍") tests between the live chunk fold and the history fold no
   longer need to exclude steered sessions.

Two further asymmetries ride along and are likewise accepted:

- **Encrypted reasoning is unrecoverable.** openai-responses providers store
  thinking only as an encrypted blob (`thinking: ""` +
  `thinkingSignature.encrypted_content`), so refreshed transcripts omit those
  reasoning parts. No placeholder part is emitted.
- **History is richer than live.** Assistant entries carry
  `usage`/`cost`/`model`/`provider`/`stopReason`, which fold into
  `message.metadata`; live messages have no equivalent.

## Consequences

- ~~If this ever needs to converge, the fix is splitting the _live_ transform
  on `turn_end`/`turn_start`.~~ **Corrected:** that direction was wrong — a
  pi "turn" is one LLM round-trip (one assistant response + its tool results),
  so a single prompt with N tool calls spans N turns; splitting there would
  shatter one reply into N messages. The correct boundary is the user-message
  marker, which is what the live transform now uses.
- Reasoning visibility differs by provider family (Anthropic plaintext
  survives refresh; openai-responses does not). This is pi's storage
  limitation, not ours.
