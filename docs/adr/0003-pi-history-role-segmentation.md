# Pi history folds by user-entry segmentation; steer re-segments on refresh

Pi session history (`session.getMessages`) is folded from the agent's native
`SessionEntry` branch by **role**: every `user` message entry opens a new
message, and all `assistant`/`toolResult` entries up to the next `user` entry
collapse into a single assistant `UIMessage`. Message ids are the entry id of
the segment's first assistant entry (assistant messages) or the user entry id
(user messages). A conversation that was steered mid-turn therefore renders as
**more messages after a refresh than it did live** — this divergence is
accepted, not a bug.

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
  on pi's internal `turn_end`/`turn_start`. A steered run streams as **one**
  assistant message; the vibest pi adapter
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
2. Keep the live transform untouched. The live path is the only currently
   stable pipeline, and one-message-per-run is the correct _live_ rendering of
   a steer (the reply continues in place).
3. Accept that a steered conversation re-segments on refresh (e.g. 3 messages
   live → 4 from history). History is the more faithful record: the user did
   send two inputs.
4. Parity ("对拍") tests between the live chunk fold and the history fold are
   scoped to sessions without steer; steered sessions get their own
   history-side assertions instead.

Two further asymmetries ride along and are likewise accepted:

- **Encrypted reasoning is unrecoverable.** openai-responses providers store
  thinking only as an encrypted blob (`thinking: ""` +
  `thinkingSignature.encrypted_content`), so refreshed transcripts omit those
  reasoning parts. No placeholder part is emitted.
- **History is richer than live.** Assistant entries carry
  `usage`/`cost`/`model`/`provider`/`stopReason`, which fold into
  `message.metadata`; live messages have no equivalent.

## Consequences

- Refreshing a steered conversation visibly changes its segmentation. If this
  ever needs to converge, the fix is splitting the _live_ transform on
  `turn_end`/`turn_start` (aligning it with history), never the reverse —
  history segmentation follows pi's persisted ground truth.
- The parity test suite must document its no-steer scope so a future reader
  doesn't "fix" the exclusion.
- Reasoning visibility differs by provider family (Anthropic plaintext
  survives refresh; openai-responses does not). This is pi's storage
  limitation, not ours.
