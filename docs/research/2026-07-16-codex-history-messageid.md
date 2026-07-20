# Codex history read & messageId stability

Research for the session/streaming refactor (`docs/wayfinder/session-streaming-refactor/map.md`,
`docs/research/2026-07-16-client-consumption-shape.md`). Question: can the codex adapter emit a
`start.messageId` on the first streaming chunk of a turn that is IDENTICAL to the `id` of the
committed assistant `UIMessage` a future `getMessages` would return — the equality AbstractChat
uses to decide replace-in-place vs. append.

All paths are relative to the repo root. Line numbers are from the tree at HEAD `66530d1`.

---

## Summary / recommendation

**Codex is in a much stronger position than claude-code.** It has a native, persisted per-turn
identifier — `Turn.id` — that (a) is already emitted as the live `start.messageId` today, and
(b) is retrievable from committed history. So codex does **not** need a fabricated id-synthesis
rule.

- **Live `start.messageId` = `turn.id` today.** `transform.ts` maps `turn/started` →
  `{ type: "start", messageId: notification.params.turn.id, ... }`
  (`packages/harness/src/codex/transform.ts:167-172`), asserted by
  `packages/harness/test/codex/transform.test.ts:10-16` (`turn.id "turn1"` → `messageId: "turn1"`).
- **The same `turn.id` is in committed history.** `thread/read { threadId, includeTurns: true }`
  returns `Thread.turns: Array<Turn>` with `Turn.id`
  (`protocol/v2/ThreadReadParams.ts`, `protocol/v2/Thread.ts`, `protocol/v2/Turn.ts`). The same
  turns array is also populated on `thread/resume`.
- **Recommended rule:** normalize **one assistant `UIMessage` per `Turn`, keyed by `Turn.id`**,
  produced by a cold-read mapper that agrees with the live transform on `messageId = turn.id`.
  This mirrors claude-code's fold architecture (`packages/harness/src/claude-code/fold.ts`) but
  uses codex's native id instead of a synthesized one.

**Can codex share claude-code's rule?** It shares the _architecture_ (one UIMessage per
turn/response, produced by a single transform reused live + cold) but **not the concrete id
source**. Claude-code's live transform emits a bare `{ type: "start" }` with **no** messageId
(`packages/harness/src/claude-code/transform.ts:25`), so claude-code must _synthesize_ a per-turn
id; codex should _not_ be forced onto that synthesis — it already has `turn.id`. Force-sharing a
synthesis rule would throw away codex's stronger native guarantee.

**Biggest risk:** `turn.id` stability across `thread/resume` / process restart is asserted by the
protocol shape and doc comments but **not yet verified against a live codex binary**, and codex's
`getMessages`/cold-read mapper **does not exist yet** (only anticipated by comments). The
`turn.ended`-before-committed ordering is not yet enforced. See §3–§4.

---

## Q1 — History read

**Yes, there is a native committed-history read API, and history survives resume.**

`thread/read` is a first-class request method (`protocol/ClientRequest.ts:91`, in the
`ClientRequest` union: `{ "method": "thread/read", id, params: ThreadReadParams }`).

`packages/harness/src/codex/protocol/v2/ThreadReadParams.ts`:

```ts
export type ThreadReadParams = {
  threadId: string;
  /** When true, include turns and their items from rollout history. */
  includeTurns?: boolean;
};
```

`ThreadReadResponse.ts` → `{ thread: Thread }`. The persisted history lives on `Thread.turns`
(`protocol/v2/Thread.ts`), whose doc comment is explicit about _when_ it is populated:

```ts
/**
 * Only populated on `thread/resume`, `thread/rollback`, `thread/fork`, and `thread/read`
 * (when `includeTurns` is true) responses.
 * For all other responses and notifications returning a Thread,
 * the turns field will be an empty list.
 */
turns: Array<Turn>,
```

**Does history survive `thread/resume`?** Yes — resume is listed in that same comment as populating
`turns`. (Note: the _adapter's_ `resume` currently discards them — see §3.) `ThreadResumeParams.ts`
documents three resume modes (by thread_id / by history / by path) with rollout loaded from disk;
`thread/resume` reloads the persisted rollout.

**Shape of a persisted thread item.** `Turn` (`protocol/v2/Turn.ts`):

```ts
export type Turn = {
  id: string;
  items: Array<ThreadItem>;
  itemsView: TurnItemsView; // "notLoaded" | "summary" | "full"
  status: TurnStatus; // "completed" | "interrupted" | "failed" | "inProgress"
  error: TurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
};
```

`ThreadItem` (`protocol/v2/ThreadItem.ts`) is a discriminated union; **every variant carries a
stable `id: string`**: `userMessage`, `hookPrompt`, `agentMessage` (`{ id, text, phase,
memoryCitation }`), `plan`, `reasoning` (`{ id, summary: string[], content: string[] }`),
`commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`,
`webSearch`, `imageView`, `imageGeneration`, `enteredReviewMode`, `exitedReviewMode`,
`contextCompaction`, etc. These item `id`s are the same identifiers used as `toolCallId` /
text-block id in the live transform (§2), so a cold read can reproduce block-level ids too.

`TurnItemsView` is a paging hint: `thread/read` may return `"summary"` or `"notLoaded"` unless
`includeTurns`/pagination asks for `"full"`. `ThreadResumeInitialTurnsPageParams.ts` and
`TurnsPage.ts` (`{ data: Turn[], nextCursor, backwardsCursor }`) show history is paginated — a
cold-read mapper must page to `itemsView: "full"` to get item bodies, not just summaries.

---

## Q2 — Normalization to one assistant UIMessage per turn (live path today)

The live transform is a per-thread generator factory,
`createCodexTransform()` in `packages/harness/src/codex/transform.ts:68`. Codex streams _items_
(`item/started` → deltas → `item/completed`); the transform folds them into the AI-SDK
`UIMessageChunk` stream. The message id is produced **once per turn**, from `turn/started`:

`transform.ts:166-173`:

```ts
case "turn/started":
  yield {
    type: "start",
    messageId: notification.params.turn.id,
    messageMetadata: { sessionId: notification.params.threadId },
  };
  break;
```

Everything after that becomes a _part_ of that single message (no further `start` until the next
turn):

- `agentMessage` → `text-start` / `text-delta` (`item/agentMessage/delta`) / `text-end`, keyed by
  `item.id` (`transform.ts:76-84, 102-103, 124-133, 179-186`). No-delta fallback emits the whole
  `item.text` on `item/completed`.
- `reasoning` → `reasoning-*`, keyed by `item.id`; both `item/reasoning/textDelta` and
  `.../summaryTextDelta` route to one reasoning block (`transform.ts:81-85, 135-143, 190-198`);
  `reasoningText()` picks raw content else summary (`transform.ts:63-65`).
- tool items (`commandExecution`, `fileChange`, `webSearch`, `mcpToolCall`, `dynamicToolCall`,
  `collabAgentToolCall`, `imageGeneration`, `imageView`) → `tool-input-available` on
  `item/started` + `tool-output-available` on `item/completed`, `toolCallId: item.id`, the whole
  item forwarded as `input`/`output` (`transform.ts:87-99, 112-121`). `isToolThreadItem` /
  `isDynamicToolThreadItem` are the **shared predicates the comment says the cold-read mapper must
  reuse** (`transform.ts:23-60`).
- bucket-3 items (`plan`, `hookPrompt`, `enteredReviewMode`, `exitedReviewMode`,
  `contextCompaction`) → typed `data-*` parts (`transform.ts:146-160`).
- `userMessage` items are **skipped** in the live transform (`transform.ts:161` — "it's the echo of
  our own turn input"). Note: `ui-message.ts:30-31` reserves a `data-userMessage` type "History
  replay only — never emitted by the live transform," anticipating the cold-read mapper.
- `turn/completed` → `data-turn/completed` + `finish` (`transform.ts:212-215`); terminal `error` →
  `data-turn/error` + `error` + `finish` (`transform.ts:217-222`).

The `finish` chunk closes the message; the turn's `output` stream in `agent.ts` runs until it
(`Stream.takeUntil((chunk) => chunk.type === "finish")`, `agent.ts:727`).

**How the message id is produced today:** `messageId = turn.id`, straight from the `turn/started`
notification. No synthesis, no counter. Confirmed by `transform.test.ts:10-16`. Steering
(`turn/steer`, `agent.ts:618-635`) reuses the _same_ `turnId`, so a steered continuation stays in
the same message.

There is **no cold-read / `getMessages` mapper for codex yet** — `grep` for `thread/read`,
`includeTurns`, `.turns`, `getMessages`, "history" across `packages/harness/src/codex/` finds only
the anticipatory comments in `transform.ts` and `ui-message.ts`. The contract already reserves the
slot: `SessionMessages = { messages: ReadonlyArray<UIMessage> }`
(`packages/contract/src/domain.ts:308-310`), `session.getMessages` returns it
(`packages/contract/src/session.ts:45`), and `session-service.ts:529` currently returns
`history: []` (the "empty-array seam" the map calls out as a dev-only stopgap).

Claude-code's cold path already exists as the reference: `foldToUIMessages`
(`packages/harness/src/claude-code/fold.ts:11-33`) replays native `SDKMessage`s through the _same
live transform_ into `readUIMessageStream`, then dedupes by `message.id`. Codex should build the
analogous mapper, feeding `Thread.turns[].items[]` (or synthesized `turn/started` +
`item/completed` + `turn/completed` notifications) through a transform that emits the same
`messageId = turn.id`.

---

## Q3 — THE KEY QUESTION: messageId stability

**There IS a native identifier — `Turn.id` — that satisfies both (a) and (b).**

(a) **Appears on streaming/incremental output.** `turn/started` carries `turn.id`
(`protocol/v2/TurnStartedNotification.ts` → `{ threadId, turn: Turn }`), and the live transform
already emits it as `start.messageId` (`transform.ts:170`). The turn id also rides on
`ItemStartedNotification` / `ItemCompletedNotification` (`{ item, threadId, turnId, ... }`) and on
`TurnCompletedNotification` (`{ threadId, turn }`). `turn/start` request also returns it
(`TurnStartResponse = { turn: Turn }`; `agent.ts:654-657, 675` reads `response.turn.id`).

(b) **Appears on the same item read back as committed history.** `thread/read`
(`includeTurns:true`) and `thread/resume` return `Thread.turns[].id` — the same `Turn.id`
(`protocol/v2/Thread.ts`, `Turn.ts`). Item-level `id`s (`toolCallId`, text/reasoning block ids)
likewise round-trip because `ThreadItem.id` is persisted.

So **the adapter can emit `turn.id` in the first `start` chunk (it already does) AND reproduce it
when normalizing history** (one UIMessage per `Turn`, `id = Turn.id`). No id synthesis is needed.

**Stable across a resume?** The protocol shape says yes: `turn.id` is part of the persisted
rollout that `thread/resume` / `thread/read` reload, and `ThreadResumeParams` describes loading the
thread "from disk by thread_id." A completed turn's id is therefore a durable property of the
rollout, not a per-connection ephemeral. **Caveat:** this is inferred from the generated TS
bindings and doc comments (codex-cli 0.142.5, per `protocol/README.md`); the actual codex binary is
not vendored in the repo (only the generated types), so I could not execute a resume and diff the
ids. This should be verified empirically before treating it as load-bearing (see risks).

**Can codex share claude-code's rule?**

- Claude-code's live transform emits `{ type: "start" }` with **no** `messageId`
  (`packages/harness/src/claude-code/transform.ts:25`). Its text blocks use `message.message.id`
  (the SDK assistant-message id) as the _block_ id (`transform.ts:36-39`), and its cold fold dedupes
  by whatever `message.id` `readUIMessageStream` assigns. Claude-code has **no single native
  per-turn message id on the wire**, so the sibling must _synthesize_ one (or arrange the transform
  so live and cold agree by construction, the way `fold.ts` reuses the transform).
- Codex **does** have a native per-turn id. It should keep using `turn.id`.

**Verdict:** codex and claude-code can share the _invariant_ and the _fold architecture_ ("one
assistant UIMessage per turn/response; message id emitted on the `start` chunk; the cold-read mapper
reuses the live transform so ids match by construction"), but **not the concrete id source**. Codex
uses native `turn.id`; claude-code synthesizes. Codex needs its **own** (simpler, native) rule —
and it is strictly more robust than any synthesis, so it should not be collapsed into claude-code's.

**If codex had no native id (it does, so this is contingency only):** the fallback synthesis would
be a deterministic function of `(threadId, turn-ordinal)` — but turn ordinal is fragile across
compaction/rollback (`contextCompaction`, `thread/rollback` exist in the protocol) and across
resume where earlier turns may be paged as `notLoaded`. Native `turn.id` avoids all of these
failure modes, which is why it is the recommendation.

**Residual failure modes even with `turn.id`:**

1. **`userMessage` echo folding.** The live message (id=`turn.id`) contains only assistant parts
   (userMessage is skipped, `transform.ts:161`). The cold-read mapper must NOT fold the turn's
   `userMessage` item into that same `turn.id` message as an assistant part, or the user's prompt
   would render inside the assistant bubble. Options: emit it as a separate user `UIMessage`, or as
   the reserved `data-userMessage` part on a distinct message. Id equality still holds (only the id
   must match; parts may differ, since AbstractChat replaces the whole message on `onFinish`), but
   role/shape correctness is a real hazard.
2. **Steering.** `turn/steer` keeps the same `turnId` (`agent.ts:618-635`), so multi-prompt steered
   turns collapse into one message — consistent live and cold. Fine, but worth stating as intended.
3. **Paging.** Cold read must request `itemsView: "full"` and page all turns
   (`TurnsPage.nextCursor`), else history messages are missing parts or turns.
4. **Compaction / rollback.** `contextCompaction` items and `thread/rollback` can drop or rewrite
   history; a cold read after compaction may not contain a turn that a live client already
   rendered. Id equality degrades gracefully (missing → append), but the projection should tolerate
   it.

---

## Q4 — `turn.ended` commit ordering

**Current mapping.** `to-session-event.ts` maps `turn/completed` → `session.turn.ended`
(`packages/harness/src/codex/to-session-event.ts:17-42`): `interrupted` → `canceled`, `failed` →
`failed`, else `completed`; a terminal `error` notification (`willRetry: false`) also →
`session.turn.ended / failed` (`:43-53`). Retryable errors are swallowed (`:46`).

**Is the final assistant message immediately readable when `turn/completed` fires?**

The strongest signal is that **`TurnCompletedNotification` itself carries the fully-formed
committed turn**: `{ threadId, turn: Turn }` where `Turn` includes `items`, `status`, `error`,
`completedAt`, and `itemsView` (`protocol/v2/TurnCompletedNotification.ts`, `Turn.ts`). So the
committed content is available _in the notification payload_ at the moment
`session.turn.ended` would be derived — the adapter does not have to round-trip through
`thread/read` to know the final message.

**But `thread/read` readability lag is unverified.** Whether the on-disk rollout that `thread/read`
serves is flushed _before or after_ the `turn/completed` notification is emitted is **not
observable from the TS bindings** and is not asserted anywhere in the repo (no test exercises
`thread/read` after `turn/completed`). There is a plausible race: notification emitted → rollout
file flushed slightly later. The design requires `session.turn.ended` to publish only _after_ the
turn's history is committed and readable.

**Recommendation for the invariant:** derive the committed history for a just-ended turn from the
**`turn/completed` (`TurnCompletedNotification.turn`) payload itself** — treat that Turn as the
authoritative committed message and publish `session.turn.ended` after folding it into the
projection — rather than eagerly re-reading `thread/read`. This sidesteps the flush-lag entirely:
the payload is by construction the committed turn (`status: "completed"`, `completedAt` set). Use
`thread/read` only for _cold_ reconstruction (refresh / resume / restart), where the turn is long
since committed and the lag is irrelevant. If a belt-and-suspenders check is wanted, gate
`turn.ended` on a `thread/read` of that `turnId` returning `status !== "inProgress"` with
`itemsView: "full"`, but verify empirically that this does not deadlock behind the flush.

---

## Recommended approach (concrete)

1. **Keep `start.messageId = turn.id`** on the live path (already the case, `transform.ts:170`).
2. **Build a codex cold-read mapper** analogous to `claude-code/fold.ts`: fetch history via
   `thread/read { threadId, includeTurns: true }` (paging to `itemsView: "full"`), and for each
   `Turn` produce **one assistant `UIMessage` with `id = Turn.id`**, whose parts are the folded
   `Turn.items` using the **shared** `isToolThreadItem` / `isDynamicToolThreadItem` /
   `reasoningText` predicates (`transform.ts:23-65`). The cleanest implementation synthesizes
   `turn/started` + per-item `item/completed` + `turn/completed` notifications from the `Turn` and
   runs them through the existing `createCodexTransform()`, so live and cold ids match _by
   construction_ — the exact trick `fold.ts` uses.
3. **Emit the turn's `userMessage` echo as a separate user message** (or a distinct
   `data-userMessage`-bearing message), never as an assistant part on the `turn.id` message.
4. **Publish `session.turn.ended` from the `turn/completed` payload**, treating
   `TurnCompletedNotification.turn` as the committed turn; reserve `thread/read` for cold
   reconstruction. Do not couple `turn.ended` to a `thread/read` round-trip unless flush-ordering is
   verified.
5. **Fix the adapter's `resume` to (optionally) surface `Thread.turns`.** Today
   `agent.ts:542-553` discards the resume response's turns; the cold-read path (refresh/restart)
   needs them (or a follow-up `thread/read`).

## Open risks

- **`turn.id` persistence across resume/restart is inferred, not measured.** Verify against a live
  codex binary (codex-cli ≥ 0.142.5): start a turn, note `turn.id`, resume the thread, `thread/read
includeTurns:true`, confirm the same `turn.id`. This is the load-bearing assumption for the whole
  invariant.
- **`thread/read` flush lag after `turn/completed` is unmeasured** (Q4). The payload-based approach
  avoids it, but any code that re-reads must confirm timing.
- **`getMessages` for codex does not exist yet** — only anticipated by comments; the empty-array
  seam (`session-service.ts:529`) is live. The mapper above is net-new work.
- **Paging, compaction, and rollback** (`TurnsPage`, `contextCompaction`, `thread/rollback`) can
  make cold history diverge from what a live client rendered; the projection must tolerate
  missing/rewritten turns (id-equality degrades to append, which is acceptable but should be
  intentional).
- **Codex must NOT be forced onto claude-code's synthesized-id rule.** It shares the invariant and
  fold architecture, not the id source; conflating them would discard codex's stronger native
  guarantee.
