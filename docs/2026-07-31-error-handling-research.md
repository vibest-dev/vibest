# Error handling: best practices research and gap analysis

2026-07-31. Sources: Effect 4 beta installed sources + official v4 docs
(effect.website, effect.solutions, LLMS.md), the oRPC repo/docs verified
against the pinned beta.18 dist, and opencode (sst/opencode, Effect
4.0.0-beta.83) as a same-stack reference implementation. This document
records what the ecosystem considers correct, where this repo deviates, and
a recommended target design. Nothing here is implemented yet.

## 1. What the sources agree on

Three independent sources converge on the same architecture:

1. **The expected/defect line is "can the caller react?", not "where did it
   come from".** Effect's docs: typed errors are for failures the caller can
   handle (not-found, validation, conflict); defects are for unrecoverable
   situations, reported — never recovered — at the outermost boundary.
   opencode applies this aggressively: every SQLite/fs call in its core is
   `orDie`'d on the spot (142 uses), so service error channels carry _only_
   domain-meaningful failures; several methods are `Effect<A>` with no error
   type at all.

2. **One error definition style: `Schema.TaggedErrorClass`.** Effect v4's
   own agent-facing docs use it exclusively; opencode's v2 core uses it for
   every domain error (dot-namespaced tags like `"Session.NotFoundError"`,
   structured fields, `override get message()`). `Data.TaggedError` remains
   legitimate only for errors guaranteed never to serialize.

3. **Domain vocabulary and wire vocabulary are different things, translated
   explicitly at the boundary.** opencode keeps HTTP-facing error classes in
   a separate protocol package (status attached as schema annotation) and
   translates domain → boundary per handler with `catchTag`; exhaustiveness
   comes from the endpoint contract's type (a handler whose error channel
   contains an undeclared error fails to compile). Effect's own
   `unstable/rpc` goes further: per-procedure error schemas in the contract,
   serialization derived, no hand-written tables at all.

4. **oRPC's Effect extension does no mapping — manual translation at the
   seam is the intended pattern.** `handlerGen` treats exactly one thing
   specially: an effect failing with an `ORPCError` becomes a
   defined/inferable typed error. Everything else (tagged errors, defects)
   falls through to `toORPCError`: `INTERNAL_SERVER_ERROR`, generic message,
   original error kept server-side as `cause` — safe by default, nothing
   leaks. No `_tag`-based auto-mapping exists or is planned in oRPC core.

5. **Defects get one top-level catch that logs with a correlation ref and
   returns an opaque error.** opencode: `err_xxxxxxxx` ref in the log line
   and in the client-visible `UnknownError`, structured details never leak.
   oRPC's sanctioned hook for this in the Effect integration is
   `effect/wrap` (explicitly ordered so wrap-thrown ORPCErrors stay
   non-inferable).

6. **Wire error data schemas only where the client branches on payload.**
   oRPC docs: bare codes are fine and cheaper for TS; add `data:` schemas
   only when the client needs structured fields. Declared data _is_
   validated server-side; a failing validation silently demotes the error to
   undefined.

7. **Client side: `safe` + `isInferableError`** (in beta.18 `isDefinedError`
   is literally an alias of it), branch on `code`, never on message.

Other patterns worth noting: v4's wrapper-error + `reason` union
(`PlatformError`/`SystemError`, consumed via `Effect.catchReason`) as the
house style for error families; opencode's retry policy driven by data
carried _inside_ the error (`retryable`, `retryAfterMs`); opencode's
log-then-fail (`Effect.logError(...).pipe(Effect.andThen(Effect.fail(...)))`)
— never log-and-swallow.

## 2. Where this repo deviates

Ordered by structural impact.

### 2.1 Infrastructure failures ride every error channel instead of dying

`StoreReadError`/`StoreWriteError` appear in nearly every
`HarnessAgentSessionServiceShape` method signature, yet no caller anywhere —
service, router, client — does anything with them except pass them through
(`"internal"` rows in every translation table). The repository already
separates the one recoverable case (`SessionNotFound`/`SessionRefNotFound`
for a missing record), so what remains in `StoreReadError` is corruption or
permission failure — exactly the "no caller can react" case both Effect and
opencode classify as a defect.

Consequence of fixing: every service method's error union shrinks; every
`StoreReadError: "internal"` / `StoreWriteError: "internal"` row disappears;
`project.list/create` and several session ops become infallible or
single-error. This is the single change that most reduces total error
surface.

**Conflict to resolve first**: `.agents/rules/stack.md` currently mandates
"Platform failures get mapped at the seam, not propagated raw: the
repositories' StoreReadError/StoreWriteError wrap them". Wrap-then-die at
the same seam is compatible with the letter of that rule (the wrapper still
names the file and preserves the cause for the log), but the rule text and
the session-persistence docs should be amended in the same change.

### 2.2 No server-side defect boundary

The desktop MessagePort path installs `effect/wrap` with
`Effect.tapCause` logging; the main HTTP/WS path installs nothing. An
untranslated error or defect on the main path is squashed by `runPromise`,
wrapped by `toORPCError`, and vanishes — no daemon log line. The comment in
`harness/errors.ts` ("These messages end up in daemon logs") is aspirational
today. The fix is the pattern all three sources agree on: one `effect/wrap`
on the server runtime that logs non-interrupt causes with a short ref, and
(optionally) returns the ref to the client inside the generic INTERNAL
error.

### 2.3 `internalWithMessage` leaks messages the transport deliberately doesn't

oRPC's default for unknown errors is a generic message with the original
kept server-side as `cause`. `internalWithMessage` (and before it, the
hand-written `errors.INTERNAL({ message: e.message })` rows) overrides that
default and ships `AgentOpenError`/`AgentOperationError` cause summaries —
including whatever a child process printed — to the client. With 2.2 in
place (log + ref), this exposure buys nothing: drop it, let these die or map
them to a bare INTERNAL, and the wire never carries harness internals.
It also collapses the current two-forms-of-internal problem (declared
`INTERNAL` code vs generic `INTERNAL_SERVER_ERROR`) into one.

### 2.4 Two error definition styles

`src/errors.ts` uses `Data.TaggedError`; `harness/errors.ts` uses
`Schema.TaggedErrorClass` + `override get message()` + `cause:
Schema.Defect()`. The harness style is the official v4 pattern verbatim;
every field in `src/errors.ts` is schema-expressible. Converge on
`Schema.TaggedErrorClass` (mechanical change), and consider opencode-style
namespaced tags (`"Session.NotFound"`) if tag collisions ever threaten —
the `SessionNotFound` vs `HarnessSessionNotFound` naming workaround is the
symptom that motivates it.

### 2.5 Wire vocabulary is unfalsifiably broad and barely consumed

Eight declared codes; the entire frontend branches on exactly one
(`UNSUPPORTED` → `null` in `getMessages`). `SESSION_CRASHED` and `FORBIDDEN`
are produced by no handler; `CONFLICT` is produced once and consumed never.
The vocabulary should be driven by actual client branches: today that is
`UNSUPPORTED`; ticket 12's SESSION_NOT_ACTIVE→resume recovery loop is the
next real consumer. Delete the dead codes (re-adding a code later is cheap —
it's additive), and when a client branch needs payload (e.g. resume needing
the ref, CONFLICT carrying `turnId`), add a `data:` schema at that moment —
oRPC validates declared data server-side.

Client side, replace the ad-hoc `error instanceof ORPCError && error.code
=== ...` with `safe`/`isInferableError`, and add the oRPC `Registry`
augmentation so `ServerErrorCode` is the suggested code vocabulary
everywhere instead of a hand-maintained list.

### 2.6 The translation tables are the right mechanism, oversized by 2.1

All sources confirm hand-translation at the seam is the intended oRPC
pattern, and `translateErrors`' exhaustive-with-explicit-`"internal"` table
is stronger than both `Effect.catchTags` (partial by design) and oRPC's own
converter-middleware suggestion. Keep it. After 2.1 and 2.3 the tables lose
most of their `"internal"` rows and some shared groups collapse; the
remaining tables say only things a reader cares about: which domain failure
becomes which protocol code.

### 2.7 Lower priority observations

- The per-backend process/transport errors (`CodexTransportError`,
  `PiTransportError`, `CodexRpcError`, `PiRpcError`, `AgentProcessExited`,
  `AgentProtocolError`) never cross the RPC boundary; if they grow more
  cases, v4's wrapper + `reason` union (`Effect.catchReason`) is the shape
  to adopt rather than more sibling classes.
- opencode persists LLM-run errors _on the message_ (error-as-data with
  `retryable` policy inside) instead of failing the request — relevant if
  vibest ever wants turn failures rendered in the transcript rather than
  toasted.
- Custom codes map to HTTP 500 in oRPC's fetch handler; irrelevant over the
  WS transport, but worth remembering if any procedure is ever exposed over
  HTTP/OpenAPI.

## 3. Recommended target design

1. **Defect the store**: repository wraps platform failures (unchanged) but
   the wrapper dies at the repository boundary (`Effect.orDie` /
   `Effect.catchTag("StoreReadError", Effect.die)` at the method level).
   Error channels keep only `SessionNotFound`/`SessionRefNotFound`/domain
   failures. Amend stack.md and ADR wording accordingly.
2. **One defect boundary on the server runtime** (`effect/wrap`): log
   non-interrupt causes with `err_xxxxxxxx` ref via `Effect.annotateLogs`;
   client sees generic INTERNAL (+ ref). Mirrors the desktop wrapper and
   opencode's middleware.
3. **Drop `internalWithMessage`**; harness open/operation failures either
   die (they now reach the logged boundary) or map to a bare declared code.
   One kind of internal on the wire.
4. **Converge error definitions on `Schema.TaggedErrorClass`** in
   `src/errors.ts`; keep unions per operation; consider Schema unions if a
   declaration ever needs to feed the wire.
5. **Prune the contract vocabulary** to codes with real producers and
   consumers; add `data:` schemas only alongside the client branch that
   reads them (ticket 12 being the first candidate). Add the `Registry`
   augmentation; move client branching to `safe`/`isInferableError`.
6. **Keep `translateErrors`** as the seam mechanism; expect its tables to
   shrink to pure domain→code statements.

Suggested order: 2 (pure addition, closes the observability hole) → 1+3
(one PR, shrinks every channel and table) → 4 → 5. Each step is
independently landable.
