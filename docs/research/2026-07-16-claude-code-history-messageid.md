# Claude Code: history read + messageId stability for the session/streaming refactor

Research product for the wayfinder map `docs/wayfinder/session-streaming-refactor/map.md` (open item: "`session.turn.ended` 与历史提交边界的不变量最终强度"). Companion to `docs/research/2026-07-16-client-consumption-shape.md`.

Scope: `packages/harness/src/claude-code/` + the installed `@anthropic-ai/claude-agent-sdk@0.3.207`.

---

## Summary / recommendation

The invariant is **achievable but requires a change on both paths** — it does not work today.

- There **is no single native id that the current code already threads through both paths.** Today the live streaming message id is a client-side random id (`AbstractChat.generateId()`); the transform's `start` chunk carries **no** `messageId` at all. The cold-fold path (`fold.ts`) produces UIMessages with `id === ""`. So neither side emits a native, matching id.
- The SDK **does** expose a durable history read: `getSessionMessages(sessionId, {dir})` reads the on-disk JSONL transcript and returns `SessionMessage[]`, each with a top-level wire `uuid: string` and the raw `message`. The **same** wire `uuid` appears on the live `SDKAssistantMessage.uuid`. That `uuid` is persisted verbatim to JSONL and read back unchanged, so it is stable across `query({resume})`.
- **The one native id that appears on both the live stream and committed history is `SDKAssistantMessage.uuid`** (equivalently the persisted `SessionMessage.uuid`). The catch: **one agent-loop / turn contains many assistant messages** (one per model step), each with its own `uuid` and its own API `message.id`. So no native id names "the turn's UIMessage" — we must pick one deterministically.

**Recommended synthesis rule:** UIMessage id for an assistant turn = **the `uuid` of the first `assistant` SDK message of that turn**. Emit it in the `start` chunk (emitted lazily, on the first assistant message of the turn, instead of at `system/init`), and select the identical id when folding `getSessionMessages()` output into committed `UIMessage[]` using the same turn-segmentation rule. Because both sides read the same persisted `uuid`, the ids match.

**Biggest risk:** the id is only as stable as the transcript. History-rewriting events — **context compaction** (`compact_boundary`) and **refusal-fallback supersede** (`SDKAssistantMessage.supersedes` / `retracted_message_uuids`) — can evict or replace the very message whose `uuid` we chose, silently changing a committed turn's id and breaking AbstractChat's replace-vs-append reconciliation for that turn. Plus a commit-ordering lag (Q4): the JSONL write is asynchronous relative to the live `result` message, so `session.turn.ended` must not be published until the turn's messages are actually readable from disk.

---

## Q1 — How the adapter can read native committed history

### There is a first-class SDK history API (not currently used for reads)

`@anthropic-ai/claude-agent-sdk` exports `getSessionMessages`:

`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.207.../sdk.d.ts:716`

```ts
/**
 * Reads a session's conversation messages from its JSONL transcript file.
 * Parses the transcript, builds the conversation chain via parentUuid links,
 * and returns user/assistant messages in chronological order. Set
 * `includeSystemMessages: true` in options to also include system messages.
 */
export declare function getSessionMessages(
  _sessionId: string,
  _options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]>;
```

Options (`sdk.d.ts:732`): `{ dir?, limit?, offset?, includeSystemMessages?, sessionStore? }`. `dir` is the project directory (same semantics as `listSessions({dir})`); omit to search all project dirs. `includeSystemMessages:false` by default (so no `system`/`result` control frames unless requested). Companions: `listSessions` (`sdk.d.ts:922`), `getSessionInfo` (`sdk.d.ts:697`), `getSubagentMessages` (`sdk.d.ts:764`), `listSubagents` (`sdk.d.ts:977`).

The adapter already imports `getSessionInfo` (to gate resumability) but **not** `getSessionMessages`:

`packages/harness/src/claude-code/agent.ts:2`

```ts
import { getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk";
```

`agent.ts:355` uses it only as a resumability probe: `getSessionInfo(sessionId)` → if truthy, `buildSession(sessionId, { resume: sessionId })`, else `SessionNotResumable`.

### Where history lives on disk

Local JSONL transcripts live under the Claude config dir (`sdk.mjs` references `.claude/projects` and `CLAUDE_CONFIG_DIR`), one file per session: `~/.claude/projects/<sanitized-dir>/<sessionId>.jsonl`; subagent transcripts under `<sessionId>/subagents/agent-<agentId>.jsonl` (`sdk.d.ts:970`). Persistence can be disabled via `Options.persistSession:false` (`sdk.d.ts:1546`) — the adapter leaves it at the default `true`, so transcripts are written.

### Shape of a persisted message

`getSessionMessages` returns `SessionMessage[]` (`sdk.d.ts:4577`):

```ts
export declare type SessionMessage = {
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
  parent_agent_id: string | null;
};
```

Note `message: unknown` (the raw persisted Anthropic message; for assistant messages this object carries its `id` = API `msg_...`). The underlying JSONL line fields (seen in `sdk.mjs`) include `uuid`, `parentUuid`, `type`, `message`, `sessionId`, `timestamp`, `isSidechain`, `isMeta`, `isCompactSummary`. The SDK reconstructs chronological order by walking `parentUuid` links.

### Does history survive/resume correctly?

Yes for reads: `getSessionMessages` reads the persisted JSONL, so it is independent of whether a live `query` is running, and works after `query({resume})`. Important nuance about the **live** resume path: when `query({resume})` replays historical frames, the adapter's pump **drops** them, because they arrive while no turn is active:

`agent.ts:303-316` (pump) — a message is only forwarded when `turnState._tag === "Active"` yields a `token`; otherwise:

```ts
if (!token) return yield * pump; // agent.ts:316 — replayed/idle-time messages are skipped
```

So resume-replay frames never reach the client. **History must be sourced from `getSessionMessages`, not from the resume stream** — which matches the target design's separate `getMessages` method.

---

## Q2 — How chunks fold into one assistant UIMessage per agent loop, and where the id comes from today

### The render transform (live + cold-fold share it)

`createTransform()` in `packages/harness/src/claude-code/transform.ts` maps each `SDKMessage` to zero-or-more `UIMessageChunk`s. It is used in three places: live (`runtime/adapter.ts:162,308`), cold-fold (`fold.ts:16`), and a stream helper (`utils/to-ui-message.ts`).

Turn bracketing and part emission:

- `system/init` → `yield { type: "start" }` (`transform.ts:25`) **with no `messageId`**, then `data-system/init`.
- `assistant` content (`transform.ts:32-54`): for each `text` block, `text-start`/`text-delta`/`text-end` **keyed by `id = message.message.id`** (the API `msg_...`, `transform.ts:36`); for each `tool_use` block, `tool-input-available` keyed by `part.id`, classified `dynamic` if the tool name isn't in `claudeCodeTools`.
- `user` (`transform.ts:56-88`): tool_result blocks → `tool-output-available` (carrying the structured `tool_use_result`) or `tool-output-error`.
- `result` (`transform.ts:90-115`): emits `data-result/<subtype>` then `yield { type: "finish" }`.

So text/tool-call/tool-result/multiple model steps of a turn all land between one `start` and one `finish`, folding into a single assistant UIMessage's `parts`. `fold.ts` confirms this — the test "folds a single assistant turn into one UIMessage" asserts `messages.length === 1` with text + `data-system/init` + `data-result/success` parts (`test/claude-code/fold.test.ts:11-30`).

### Where the message id comes from **today** (both paths)

**Cold-fold path** (`fold.ts`): the transform output is run through `readUIMessageStream({ stream })` and collected `byId`:

```ts
// fold.ts:26-30
const byId = new Map<string, ClaudeCodeUIMessage>();
for await (const message of readUIMessageStream({ stream })) {
  byId.set(message.id, message as ClaudeCodeUIMessage);
}
return [...byId.values()];
```

`readUIMessageStream` is called **without a `message` argument**, so it initializes the streaming state id to `""` (ai@7.0.22 `dist/index.js:10267-10269` → `messageId: message?.id ?? ""`; `createStreamingUIMessageState` at `6479-6489` sets `message.id = messageId`). The `start` handler only overrides the id when the chunk carries one (`index.js:7024-7027`):

```ts
case "start": {
  if (chunk.messageId != null) { state.message.id = chunk.messageId; }
  ...
}
```

The transform never sets `start.messageId`, so **every folded UIMessage id stays `""`**. (The fold tests never assert on `.id`, which is why this passes unnoticed.)

**Live path** (adapter → client `AbstractChat`): `AbstractChat.makeRequest` creates the streaming message with a fresh **client-generated random id** (`index.js:16712-16716`):

```ts
state: createStreamingUIMessageState({
  lastMessage: this.state.snapshot(lastMessage),
  messageId: this.generateId()
}),
```

Again, because the transform's `start` chunk carries no `messageId`, this random id is never overridden, so the committed streaming message id is a **client random id unrelated to any native/transcript id**. Reconciliation then hinges on `replaceLastMessage = state.message.id === lastMessage?.id` (`index.js:16746`).

**Conclusion for Q2:** today the message id is either `""` (history/fold) or a client random id (live). Neither derives from a native identifier, and the two paths cannot possibly agree.

---

## Q3 — THE KEY QUESTION: is there a native id shared by streaming + committed history?

### Native id candidates and where they appear

| Candidate                                                                                  | Live stream                                                         | Committed history (`getSessionMessages`)              | Granularity                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| `SDKAssistantMessage.uuid` (`sdk.d.ts:2791`)                                               | ✅ top-level field                                                  | ✅ `SessionMessage.uuid` (`sdk.d.ts:4583`)            | **per SDK message** (many per turn)     |
| API `message.id` (`msg_...`, inside `SDKAssistantMessage.message`, `sdk.d.ts:2788`)        | ✅ (transform already uses it for text-part ids, `transform.ts:36`) | ✅ inside `SessionMessage.message` (untyped)          | **per model step** (many per turn)      |
| daemon `turnId` (`agent.ts:470` `uuid()`)                                                  | ✅ but synthesized locally                                          | ❌ not persisted, not reconstructable from transcript | per turn                                |
| hook `prompt_id` (`sdk.d.ts:168`, "correlates a prompt with all events until next prompt") | ❌ hook/OTel only, not on `SDKMessage`                              | ❌                                                    | per turn (ideal grain, but unavailable) |

So the **only native id present on both the live stream and committed history is the wire `uuid`** (and, secondarily, the API `message.id` — but it lives in the untyped `message` payload). `SDKAssistantMessage.uuid` is defined as the wire uuid; the SDK persists it verbatim to JSONL and `getSessionMessages` returns it as `SessionMessage.uuid`. It is therefore **stable across `query({resume})`** (resume re-reads the same JSONL).

### The mismatch: id grain vs. UIMessage grain

The invariant needs **one id per assistant UIMessage = one per agent loop/turn**. But a single turn produces **multiple** `SDKAssistantMessage`s (text step → tool_use step → post-tool text step → …), each with a distinct `uuid` and distinct `message.id`. No native id names the _turn_. So a **synthesis rule** is required even though a native id exists.

### Recommended synthesis rule

**UIMessage id = the `uuid` of the FIRST `assistant` message of the turn.**

- **Live side:** stop emitting `start` at `system/init`. Instead, on the first `assistant` message of a turn, emit `{ type: "start", messageId: <that message's uuid> }`. That id then overrides `state.message.id` in both `processUIMessageStream` and `readUIMessageStream` (verified at `index.js:7024-7027`), so the client's streaming message adopts the native id, and `replaceLastMessage`/`pushMessage` reconciliation keys off it.
- **History side (`getMessages`):** read `getSessionMessages(sessionId, {dir})`, segment into turns (see failure mode #1), and for each assistant turn set the committed `UIMessage.id` = the first assistant message's `uuid`. Use the **same** transform to build parts (the cold-fold `fold.ts` machinery already does this), but seed each turn's id from the same rule instead of leaving it `""`.

Because both sides read the identical persisted `uuid`, the ids match, and after a refresh/reconnect AbstractChat replaces-in-place instead of appending.

(Choosing `uuid` over API `message.id`: `uuid` is a typed top-level field on both `SDKAssistantMessage` and `SessionMessage`, whereas `message.id` requires reaching into `message: unknown`. Either is 1:1 per model step; `uuid` is cleaner to thread.)

### If we wanted to avoid the transcript's fragility

An alternative is a **daemon-owned deterministic id** persisted in the daemon's own session metadata (`~/.vibest/storage/sessions/...`), e.g. record `{turnIndex → firstAssistantUuid}` or mint `sha(sessionId, turnIndex)` at turn start and store it. This decouples the committed id from transcript rewrites, but then `getMessages` must map transcript turns back to those recorded ids — reintroducing the same segmentation problem and adding a second source of truth to keep in sync. Recommendation: start with the first-assistant-`uuid` rule; escalate to daemon-owned ids only if compaction/supersede churn proves damaging in practice.

---

## Q4 — turn.ended commit ordering: is history readable immediately after the result?

**Not reliably immediate.** The live turn-over signal is the `result` SDK message, folded into `session.turn.ended`:

`packages/harness/src/claude-code/to-session-event.ts:10-27` — on `message.type === "result"`, returns `{ type: "session.turn.ended", ... }`; the live adapter emits it and clears the active turn (`runtime/adapter.ts:316-321`).

But `getSessionMessages` reads the **on-disk JSONL**, and the subprocess writes that file asynchronously. The SDK's flush controls (`sessionStoreFlush: 'batched' | 'eager'`, `sdk.d.ts:1566,4758`) are documented only for the external `sessionStore` mirror, not for the local JSONL write, and there is **no event on the `SDKMessage` stream that confirms "the turn's assistant messages are now durably on disk."** So there is a window where `result` has arrived on the live stream but `getSessionMessages()` still returns the turn's messages partially or not at all.

**Implication for the design:** the map's requirement — publish `session.turn.ended` only _after_ the turn's history is committed and readable — cannot be satisfied by forwarding the `result` frame directly. The daemon should gate `turn.ended` behind a readability check, e.g. after `result`, poll `getSessionMessages(sessionId)` until the turn's last assistant `uuid` (which the adapter saw live) is present, with a bounded timeout, then publish `turn.ended`. (An alternative is to opt into an `InMemorySessionStore`/custom `SessionStore` mirror with `sessionStoreFlush:'eager'` and read committed history from that store — the write-then-read ordering there is under our control — but that is a larger change.)

---

## Recommended approach (concrete)

1. **Add a history read** in the claude-code agent: wrap `getSessionMessages(sessionId, {dir: cwd})` (mirror the existing `getSessionInfo` Effect-wrapping in `agent.ts:355-366`). Feed the raw `SessionMessage[]` into the existing render transform.
2. **Turn segmentation, shared by both paths.** Define a single rule: a new turn starts at each top-level user prompt (`type:'user'`, `parent_tool_use_id === null`, content is not a `tool_result`); subsequent `tool_result` user messages and `assistant` messages belong to the current turn. Apply it identically in the live pump and in the history fold.
3. **Seed the id from the first assistant `uuid`.** Live: emit `{type:'start', messageId: firstAssistantUuid}` lazily on the first assistant message of a turn (replace the `system/init`-anchored `start` in `transform.ts:25`). History: in `fold.ts`, seed each turn's `readUIMessageStream({ message: { id: firstAssistantUuid, role:'assistant', parts:[] } })` (or set `start.messageId`) so the folded UIMessage adopts the same id instead of `""`.
4. **Gate `turn.ended` on readability.** After the `result` frame, confirm the turn's assistant `uuid`s are returned by `getSessionMessages` (bounded poll) before publishing `session.turn.ended` (`to-session-event.ts` / `runtime/adapter.ts:316`).
5. **Keep `fold.ts` as the single normalizer** so live and history produce byte-identical `parts`; only the id seeding differs.

---

## Failure modes / open risks

1. **Turn segmentation drift (highest-frequency risk).** `getSessionMessages` (default `includeSystemMessages:false`) omits `system`/`result` frames, so the history fold has **no explicit turn boundaries** — it must infer them from user-prompt structure, while the live path has `result` frames. If the two segmentation rules disagree by even one message, the "first assistant" — and thus the id — diverges. This must be covered by a shared, tested helper.
2. **Compaction rewrites history.** `compact_boundary` (`transform.ts:27`, `SDKCompactBoundaryMessage`) summarizes older turns; pre-compact assistant messages (and their `uuid`s) may not survive in readable form. A committed turn's id can change after compaction → AbstractChat appends a duplicate instead of replacing. Long sessions are exposed.
3. **Refusal-fallback supersede.** `SDKAssistantMessage.supersedes` / the turn-end `model_refusal_fallback` `retracted_message_uuids` (`sdk.d.ts:2794-2797,3984`) evict already-delivered messages. If the evicted message is the turn's _first_ assistant message, the chosen id disappears from history. Mitigation: pick the first _surviving_ assistant message, and apply eviction identically on both sides.
4. **Turns with no assistant message.** An immediate error `result` (e.g. `error_max_turns`) yields a turn with no assistant `uuid`. Need a deterministic fallback id (e.g. derive from the user prompt's `uuid`, which is also persisted) that both paths reproduce.
5. **Commit lag (Q4).** Publishing `turn.ended` before the JSONL flush makes an immediate `getMessages` return stale data; the readability gate is mandatory, and its bounded timeout introduces a failure branch (what to do if the flush never lands).
6. **`message: unknown` typing.** `SessionMessage.message` is untyped; the history fold must cast/validate it into the `SDKMessage` shape the transform expects. Malformed or schema-drifted lines (older CLI versions) could break the fold.
7. **`dir` resolution.** `getSessionMessages` needs the project `dir` to locate the transcript (or it scans all projects — slower, and ambiguous if the same sessionId theoretically appears twice). The daemon must pass the session's cwd; the adapter currently "只见 cwd 不见 projectId" per the map, so cwd is available.
