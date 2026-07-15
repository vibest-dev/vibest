# Effect Native Harness Agent Runtime — Implementation Plan

> **Design source:** [`docs/2026-07-15-effect-native-harness-agent-runtime-design.md`](../2026-07-15-effect-native-harness-agent-runtime-design.md)
> **Reference research:** [`docs/2026-07-15-t3code-effect-agent-integration-research.md`](../2026-07-15-t3code-effect-agent-integration-research.md)
> **Goal:** Replace the Promise/AsyncGenerator-based Agent runtime in `packages/harness` with an Effect-native runtime while preserving the current Claude/Codex RPC behavior during migration.
> **Execution rule:** Complete tasks in dependency order. Each task is independently tested, reviewed, and committed before dependents begin.

## Architecture Summary

The implementation converges on two deep modules:

```text
HarnessAgentRegistry
  └── selects lightweight Claude/Codex adapters

HarnessAgentSessionService
  ├── owns active sessions
  ├── owns session child Scopes
  ├── owns create/resume single-flight
  ├── owns event pump Fibers
  ├── owns active-turn snapshot projection
  └── publishes to EventBus
```

Concrete adapters remain Effect-typed Shapes:

```text
ClaudeCodeAdapter
  └── Queue → AsyncIterable SDK bridge
      AsyncIterable → Stream output bridge
      Deferred permission bridge

CodexAdapter
  └── lazy, restartable CodexTransport
      JSONL Queue parser
      Deferred request correlation
      generation-safe process ownership
```

Effect Schema is the source of truth for new Agent schemas. A single `toStandardSchema` helper exposes validation and JSON Schema capabilities to both oRPC and AI SDK:

```text
Effect Schema
    └── toStandardSchema
          ├── StandardSchemaV1.validate      → oRPC
          └── StandardJSONSchemaV1.jsonSchema → AI SDK
```

## Global Constraints

- Pin `effect`, `@effect/platform-node`, and `@effect/vitest` to exactly `4.0.0-beta.97` through the pnpm catalog; every package must resolve the same Effect instance.
- Keep oRPC at `2.0.0-beta.16`.
- Use APIs verified against the installed Effect v4 declarations. Do not use `Layer.scoped`, `Stream.mapConcat`, or `Stream.mapFilter`.
- Raw Effect Schema is not passed directly to oRPC or AI SDK. Use `toStandardSchema`.
- Do not create separate `toAiSdkSchema` and `toOrpcSchema` helpers.
- Pure transforms remain pure: `transform`, `toSessionEvent`, render policy, and native request mapping.
- Promise/AsyncIterable is allowed only at third-party seams: Anthropic SDK callbacks, Node child-process callbacks, AI SDK, and oRPC transport.
- Preserve user-visible Claude behavior while moving to the unified contract:
  - per-turn `model`;
  - text and inspector message parts;
  - normalized capabilities;
  - streamed render chunk ordering.
- Codex app-server remains lazy and restartable. Constructing the root Layer must not spawn Codex.
- SessionService, not an exposed SessionManager, owns session state and child Scopes.
- A canceled RPC caller must not cancel shared session/transport construction.
- No unbounded subscriber queues once render chunks enter EventBus.
- New Effect runtime tests use `@effect/vitest` with `it.effect` / `it.layer`; do not add manual `Effect.runPromise`, `Effect.runSync`, or `ManagedRuntime.make` except in tests dedicated to an external boundary.
- Tests must not depend on fixed sleeps. Use Deferred, TestClock, stream collection, event-pump barriers, or `vi.waitFor`.
- Hoist compiled Effect Schema decoders/encoders/guards to module scope instead of rebuilding them in hot functions.
- Prefer `effect/unstable/process/ChildProcessSpawner` with `@effect/platform-node/NodeServices`; use raw Node child-process callbacks only when an API gap is demonstrated.
- Run Oxfmt/Oxlint from the repository root. Do not introduce Prettier/ESLint.

## Dependency Graph

```text
Task 1  Characterization baseline
   │
   ▼
Task 2  Effect foundation + Standard Schema spike
   │
   ├───────────────┐
   ▼               ▼
Task 3          Task 4
Domain model    CodexTransport
+ lifecycle        │
   │               ▼
   │            Task 5
   │            Codex adapter
   │
   └───────┬───────┘
           ▼
        Task 6
        Claude adapter
           │
           ▼
        Task 7
        Registry + SessionService + snapshot
           │
           ▼
        Task 8
        Bounded EventBus + gap
           │
           ▼
        Task 9
        Unified session RPC migration
           │
           ▼
        Task 10
        Runtime ownership + shutdown
           │
           ▼
        Task 11
        Unified client subscription + cleanup
           │
           ▼
        Task 12
        Final Schema/tool cleanup + full verification
```

Tasks 3 and 4 can run in parallel only if their branches do not both modify shared exports or `packages/harness/package.json`. Otherwise serialize them.

## Implementation Status

Current implementation status:

- Task 2 is in progress: Effect packages are pinned and `toStandardSchema`, oRPC/AI SDK interop, event-iterator coverage, `@effect/vitest`, ChildProcessSpawner, and app-build verification are implemented. Wire schemas now live in `@vibest/contract`; harness depends on contract, never the reverse. A pure browser subpath keeps Effect out of the app bundle. The server CLI bundle is now 784.22 kB (181.17 kB gzip), up from 227.54 kB (55.74 kB gzip); packaging/externalization remains an explicit follow-up.
- Task 3 is in progress: core IDs, request/response schemas, event schemas, tagged errors, runtime interfaces, and the pure SessionLifecycle are migrated. Removing migration-only `native: unknown` fields remains.
- Task 4 is complete: the scoped ChildProcessSpawner JSONL transport, request correlation, typed protocol/process errors, bounded protocol queues, and live holder wiring are implemented. The temporary Promise façade was removed rather than retained.
- Task 5 is complete: Codex implements the shared Effect-native adapter/session interface over the lazy, cancellation-safe, generation-safe transport holder.
- Task 6 is complete: Claude implements the shared Effect-native adapter/session interface with Queue input/output pumps, Deferred permission correlation, per-turn token isolation, and scoped cleanup.
- Task 7 is in progress: Registry, active-session ownership, resume/close single-flight, child Scopes, one event pump per session, bounded replay, status/pending-request projection, and degraded snapshots are implemented. Cold persisted history merge remains.
- Task 8 is complete: EventBus uses ordered, per-subscriber bounded queues with non-blocking publishing, observable delta gaps, terminal control-event overflow, filters, and scoped subscriber cleanup.
- Task 9 is complete: the provider-specific Claude/Codex contracts and routers were deleted. One `session` namespace now exposes create/resume/prompt/interrupt/close/events/snapshot/status/capabilities/respondToAgentRequest through SessionService and EventBus.
- Task 10 is complete: the module-global runtime is removed; server creation owns an idempotent RPC runtime disposer, and CLI SIGINT/SIGTERM waits for graceful disposal.
- Task 11 is in progress: the app now submits prompt receipts through the unified session RPC, consumes unified envelopes, routes normalized AgentRequests, interrupts explicitly on abort, and recovers prompt/request subscriptions from EventBus gaps with subscribe-before-snapshot replay. Browser QA and cold-history reconnect remain.
- Task 12 has not started.

---

## Task 1: Characterization Baseline

**Objective:** Lock down current externally visible behavior before changing runtime primitives.

**Paths:**

- `packages/harness/test/claude-code/agent.test.ts`
- `packages/harness/test/codex/agent.test.ts`
- `packages/harness/test/codex/app-server.test.ts`
- `packages/server/test/rpc-codex.test.ts`
- New focused tests under `packages/server/test/` and `packages/vibest/src/node/*.test.ts`

**Steps:**

- [ ] Add Claude tests proving each prompt can set `model` before submission.
- [ ] Add Claude tests for text + inspector message-part conversion.
- [ ] Add tests pinning native `SlashCommand`, `ModelInfo`, and `McpServerStatus` response shapes.
- [ ] Add Claude permission tests for allow, deny, abort, and session close with `interrupt: true`.
- [ ] Add concurrent Claude resume test proving one native resume attempt.
- [ ] Add Codex tests proving app-server is not spawned before the first session operation.
- [ ] Add Codex tests for request correlation, turn/start, turn/steer, approval, crash, and subsequent restart.
- [ ] Add close/abort idempotency tests.
- [ ] Add a server test proving current RPC chunk ordering.
- [ ] Add a server lifecycle test establishing the current HTTP/WS shutdown behavior.

**Verification:**

```bash
pnpm --filter @vibest/harness test
pnpm --filter @vibest/server test
pnpm --filter @vibest/cli test
```

**Commit:**

```text
test(harness): characterize agent runtime behavior
```

---

## Task 2: Effect Foundation and Standard Schema Spike

**Objective:** Establish exact Effect v4 APIs, shared schema interop, and typed runtime errors without changing Agent behavior.

**Paths:**

- `pnpm-workspace.yaml`
- `packages/harness/package.json`
- `packages/server/package.json`
- `packages/contract/package.json`
- `packages/harness/src/schema/standard.ts`
- `packages/harness/src/runtime/errors.ts`
- `packages/harness/src/runtime/adapter.ts`
- `packages/harness/src/runtime/index.ts`
- `packages/harness/test/schema/standard.test.ts`
- `packages/harness/test/runtime/api.test-d.ts`
- A focused ChildProcessSpawner integration test under `packages/harness/test/runtime/`

**Interfaces:**

```ts
export const toStandardSchema: <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
) => ReturnType<typeof Schema.toStandardJSONSchemaV1>;
```

The returned object must expose both:

```ts
schema["~standard"].validate;
schema["~standard"].jsonSchema.input;
```

**Steps:**

- [ ] Add `effect`, `@effect/platform-node`, and `@effect/vitest` at `4.0.0-beta.97` to the pnpm catalog.
- [ ] Change server to use the catalog Effect entry and add `@effect/platform-node`.
- [ ] Add Effect to harness plus `@effect/platform-node` / `@effect/vitest` test dependencies where needed.
- [ ] Do not add Effect to contract unless contract source imports Effect directly.
- [ ] Implement `toStandardSchema` by composing `Schema.toStandardSchemaV1` and `Schema.toStandardJSONSchemaV1`.
- [ ] Add an oRPC compile/runtime test using `oc.input(toStandardSchema(...))`.
- [ ] Add an AI SDK test using `tool({ inputSchema: toStandardSchema(...) })`.
- [ ] Add a mixed oRPC contract test with one Zod route and one Effect-derived Standard Schema route.
- [ ] Verify event iterator yield schemas accept the Effect-derived view.
- [ ] Verify the installed names and generic ordering for:
  - `Context.Service`;
  - `Layer.effect`;
  - `Scope.Closeable` and `Scope.fork`;
  - `Effect.forkIn` and `Effect.runtime`;
  - `Queue.bounded` / `Queue.unbounded` / queue completion;
  - `Deferred<A, E>`;
  - `SynchronizedRef`;
  - `Stream.fromQueue`, `Stream.fromAsyncIterable`, `Stream.toAsyncIterable`, `Stream.flatMap`, `Stream.filterMap`;
  - `Schema.TaggedErrorClass`;
  - `effect/unstable/process/ChildProcess` and `ChildProcessSpawner`;
  - `@effect/platform-node/NodeServices`.
- [ ] Spawn a fake JSONL child process through ChildProcessSpawner and verify scoped termination, stdio Streams/Sinks, exit status, and `forceKillAfter`.
- [ ] Decide from the spike whether CodexTransport can use Effect process services exclusively; document any raw Node fallback.
- [ ] Add one `@effect/vitest` Layer test proving scoped resource finalization without a manual runtime runner.
- [ ] Define the concrete tagged errors and aggregate error aliases from design §12.
- [ ] Export runtime types only from `@vibest/harness/runtime`.
- [ ] Measure the app production bundle with one imported Effect-derived contract schema and record the delta in the task/PR notes.

**Verification:**

```bash
pnpm install
pnpm --filter @vibest/harness test
pnpm --filter @vibest/harness typecheck
pnpm --filter @vibest/contract typecheck
pnpm --filter @vibest/app build
```

**Commit:**

```text
feat(harness): add effect runtime and standard schema foundation
```

---

## Task 3: Effect Domain Schemas and SessionLifecycle

**Objective:** Migrate shared Agent control-plane definitions to Effect Schema and implement the pure lifecycle state machine.

**Depends on:** Task 2.

**Paths:**

- `packages/harness/src/types/harness-agent-id.ts`
- `packages/harness/src/types/event.ts`
- `packages/harness/src/types/request.ts`
- `packages/harness/src/types/session.ts`
- `packages/harness/src/events/session.ts`
- `packages/harness/src/event-manifest.ts`
- `packages/harness/src/runtime/session-lifecycle.ts`
- Relevant tests under `packages/harness/test/types/` and `packages/harness/test/runtime/`

**Steps:**

- [ ] Replace Zod definitions for Agent IDs, requests, responses, token usage, turn errors, control events, session DTOs, and capability DTOs with Effect Schema.
- [ ] Keep existing exported TypeScript type names.
- [ ] Export a Standard Schema view for every schema consumed by oRPC or AI SDK.
- [ ] Remove `native: unknown` from the new wire model.
- [ ] Define JSON-safe normalized request details.
- [ ] Keep original request params, response mapper, and Deferred only inside pending runtime state.
- [ ] Add `UserInputPart`, `UserInput`, and `PromptReceipt` schemas.
- [ ] Implement a pure lifecycle reducer covering:
  - turn start/end;
  - request ask/reply/reject;
  - close/crash;
  - busy prompt/steer decision;
  - duplicate request response.
- [ ] Map implementation-invariant `LifecycleViolation` to a defect at the runtime shell, not to the public error channel.
- [ ] Add table-driven lifecycle tests.
- [ ] Update current Zod-style tests to use Effect decode/Standard Schema validation without weakening assertions.

**Verification:**

```bash
pnpm --filter @vibest/harness test
pnpm --filter @vibest/harness typecheck
pnpm --filter @vibest/contract typecheck
```

**Commit:**

```text
refactor(harness): define agent domain with effect schema
```

---

## Task 4: Effect-Native CodexTransport

**Objective:** Replace the manual Promise-based JSONL client with a scoped Effect transport and remove the harness-level Promise façade.

**Depends on:** Task 2.

**Paths:**

- New `packages/harness/src/codex/runtime/transport.ts`
- New `packages/harness/src/codex/runtime/transport-live.ts`
- Delete `packages/harness/src/codex/app-server.ts` after the native agent uses the transport directly
- `packages/harness/test/codex/transport.test.ts`
- Existing fake app-server test utilities

**Interface:**

```ts
interface CodexTransport {
  request<A>(
    method: string,
    params?: unknown,
  ): Effect.Effect<
    A,
    CodexTransportError | CodexRpcError | AgentProcessExited | AgentProtocolError
  >;
  notifications: Stream.Stream<
    ServerNotification,
    CodexTransportError | AgentProcessExited | AgentProtocolError
  >;
  serverRequests: Stream.Stream<
    ServerRequest,
    CodexTransportError | AgentProcessExited | AgentProtocolError
  >;
  respond(id: number, result: unknown): Effect.Effect<void, CodexTransportError>;
}
```

**Steps:**

- [ ] Spawn app-server through `ChildProcessSpawner` inside the transport child Scope, using `forceKillAfter` for the kill fallback.
- [ ] Adapt `ChildProcessHandle` stdin/stdout/stderr/exitCode directly to Effect Stream/Sink operations.
- [ ] If the Task 2 spike found a required API gap, isolate the raw Node `spawn` fallback behind `Effect.acquireRelease` and document why it remains.
- [ ] Parse stdout through a scoped Queue consumer fiber.
- [ ] Validate the minimal JSON-RPC frame envelope; keep generated protocol payloads as trusted version-matched types.
- [ ] Use `Deferred` for request correlation.
- [ ] Remove pending entries on success, error, interruption, process exit, and shutdown.
- [ ] Fail all pending Deferreds on process exit.
- [ ] Expose notifications and server requests as Streams.
- [ ] Preserve bounded stderr tail diagnostics.
- [ ] Implement graceful shutdown, Effect timeout, and SIGKILL fallback.
- [ ] Remove listeners and shut down queues in finalizers.
- [x] Delete `CodexAppServer`; Promise/AsyncIterable conversion belongs only at the server RPC boundary.

**Verification:**

```bash
pnpm --filter @vibest/harness test -- codex/transport
pnpm --filter @vibest/harness typecheck
```

**Commit:**

```text
refactor(harness): make codex transport effect native
```

---

## Task 5: Lazy and Restartable Codex Adapter

**Objective:** Build the Codex adapter/session runtime over CodexTransport with lazy, cancellation-safe, generation-safe process ownership.

**Depends on:** Tasks 3 and 4.

**Paths:**

- `packages/harness/src/codex/runtime/adapter.ts`
- `packages/harness/src/codex/runtime/session.ts`
- `packages/harness/src/codex/runtime/layer.ts`
- `packages/harness/src/codex/runtime/index.ts`
- `packages/harness/src/codex/agent.ts` Effect-native provider runtime
- `packages/harness/test/codex/runtime.test.ts`

**Steps:**

- [ ] Implement `Idle | Starting | Running` transport holder state.
- [ ] Use `SynchronizedRef` only for atomic state transitions.
- [ ] Start spawn/initialize in a fiber forked into the adapter Scope, never in the first caller's fiber.
- [ ] Store a shared Deferred in `Starting`; caller interruption only cancels its wait.
- [ ] Fork a transport child Scope from the adapter Scope.
- [ ] Store a monotonically increasing generation with each running transport.
- [ ] Clear the holder on exit only if the generation still matches.
- [ ] Ensure the next operation restarts after a crash.
- [ ] Bind each Codex session to a transport generation and exit signal.
- [ ] Convert notifications to render/control output using existing pure transforms.
- [ ] Implement `turn/start`, `turn/steer`, interrupt, approval, and thread unsubscribe as Effects.
- [ ] Return `PromptReceipt { turnId, cursor }`.
- [x] Expose Codex provider operations only as Effect/Stream and convert to AsyncIterable in `packages/server/src/rpc/codex.ts`.

**Verification:**

```bash
pnpm --filter @vibest/harness test -- codex
pnpm --filter @vibest/harness typecheck
```

Required assertions:

- Layer creation spawns no process.
- Concurrent first use spawns once.
- Canceling the first caller does not cancel startup.
- Crash fails sessions and pending requests.
- The next create/resume starts a new generation.
- Old generation exit cannot clear the new transport.

**Commit:**

```text
refactor(harness): add lazy restartable codex adapter
```

---

## Task 6: Effect-Native Claude Adapter

**Objective:** Replace Claude session Pushable/Promise state with Queue, Stream, Deferred, and Scope while preserving current behavior.

**Depends on:** Task 3.

**Paths:**

- `packages/harness/src/claude-code/runtime/sdk.ts`
- `packages/harness/src/claude-code/runtime/adapter.ts`
- `packages/harness/src/claude-code/runtime/session.ts`
- `packages/harness/src/claude-code/runtime/layer.ts`
- `packages/harness/src/claude-code/runtime/index.ts`
- `packages/harness/src/claude-code/agent.ts` Effect-native provider runtime
- `packages/harness/test/claude-code/runtime.test.ts`

**Steps:**

- [ ] Introduce a testable Anthropic SDK seam returning Effects/native iterables.
- [ ] Replace input Pushable with Queue and `Stream.toAsyncIterable` at the SDK boundary.
- [ ] Convert SDK query output with `Stream.fromAsyncIterable`.
- [ ] Process each native message once, combining pure render transform and lifecycle mapping.
- [ ] Allocate Claude turnId when prompt is accepted and return `PromptReceipt`.
- [ ] Preserve per-turn model selection before input submission.
- [ ] Preserve text and inspector parts.
- [ ] Replace permission resolvers with Deferred.
- [ ] Capture the session construction Runtime with `Effect.runtime`; only the SDK callback uses it to return Promise.
- [ ] On abort/close complete permission with deny and `interrupt: true`.
- [ ] Put query interruption and callback cleanup in Scope finalizers.
- [ ] Do not implement resume single-flight in the adapter.
- [x] Expose Claude provider operations only as Effect/Stream and convert to AsyncIterable in `packages/server/src/rpc/claude-code.ts`.

**Verification:**

```bash
pnpm --filter @vibest/harness test -- claude-code
pnpm --filter @vibest/harness typecheck
```

**Commit:**

```text
refactor(harness): make claude adapter effect native
```

---

## Task 7: Registry, Deep SessionService, and Snapshot Projection

**Objective:** Introduce the single ownership module for active sessions, shared construction, event pumps, and reconnect snapshots.

**Depends on:** Tasks 3, 5, and 6.

**Paths:**

- `packages/harness/src/runtime/registry.ts`
- `packages/harness/src/runtime/session-service.ts`
- `packages/harness/src/runtime/snapshot.ts`
- `packages/harness/src/runtime/index.ts`
- `packages/harness/test/runtime/session-service.test.ts`
- `packages/harness/test/runtime/snapshot.test.ts`

**Steps:**

- [ ] Build a lightweight Registry; construction must not open sessions or start Codex.
- [ ] Keep active sessions and in-flight builds private to SessionService.
- [ ] Accept `{ sessionId, harnessAgentId }` for cold resume routing; do not infer adapter from current native IDs.
- [ ] Fork session child Scopes from the long-lived SessionService Scope.
- [ ] Run create/resume builds in service-scope fibers with shared Deferreds.
- [ ] Ensure caller cancellation does not cancel the shared build.
- [ ] If all callers cancel, finish and register the session for reconnect; do not add implicit idle cleanup.
- [ ] Close failed/duplicate child Scopes on every error path.
- [ ] Start exactly one event pump per session in the child Scope.
- [ ] Add a deterministic pump barrier/drain Effect for close sequencing and tests; do not infer drain completion from sleeps.
- [ ] Use a bounded session output Queue; only session close/crash ends it.
- [ ] Make SessionService close request session close, wait for pump drain, then close Scope and remove state.
- [ ] Make close idempotent.
- [ ] Maintain snapshot projection:
  - cursor;
  - lifecycle status;
  - pending requests;
  - current/recent completed turnId;
  - render chunk replay.
- [ ] Retain completed replay until the next turn starts or cold history confirms persistence.
- [ ] Return explicit degraded snapshot state if replay is incomplete.
- [ ] Include temporary `legacyNative` capabilities for old Claude RPCs; do not expose it in the new wire contract.

**Verification:**

```bash
pnpm --filter @vibest/harness test -- runtime
pnpm --filter @vibest/harness typecheck
```

Required race tests:

- concurrent resume;
- first/last waiter cancellation;
- service shutdown during build;
- duplicate registration;
- close during pending approval;
- crash while pump is publishing;
- pump drain timeout.

**Commit:**

```text
feat(harness): add scoped agent session service
```

---

## Task 8: Bounded EventBus and Gap Recovery

**Objective:** Extend the server EventBus to carry session envelopes with per-subscriber bounded buffering and deterministic overflow semantics.

**Depends on:** Task 7.

**Paths:**

- `packages/server/src/events/event-bus.ts`
- `packages/server/src/events/index.ts`
- Harness envelope/control schemas as needed
- `packages/server/test/events.test.ts`
- New `packages/server/test/event-bus-overflow.test.ts`

**Overflow Contract:**

- Delta chunks may be dropped.
- Dropping a delta marks the subscriber gapped.
- If a non-droppable item arrives to a full subscriber Queue:
  1. atomically mark subscriber terminal-gapped;
  2. clear its data Queue;
  3. enqueue a terminal gap through a reserved control slot/state;
  4. end the subscription;
  5. require snapshot + resubscribe.
- Publishers never wait for slow subscribers.
- One subscriber cannot affect another.

**Steps:**

- [ ] Define subscription control values and Standard Schemas.
- [ ] Replace `PubSub.unbounded` delivery with per-subscriber bounded queues.
- [ ] Keep seq/cursor stamping atomic.
- [ ] Implement droppable detection for render `*-delta` chunks only.
- [ ] Implement one terminal gap that cannot be lost when the data Queue is full.
- [ ] Scope subscriber registration and Queue shutdown.
- [ ] Add session/type filters without duplicating publisher logic.
- [ ] Wire snapshot cursor semantics to SessionService projection.
- [ ] Test slow, canceled, overflowing, and concurrent subscribers.

**Verification:**

```bash
pnpm --filter @vibest/server test -- events
pnpm --filter @vibest/server typecheck
```

**Commit:**

```text
feat(server): add bounded session event subscriptions
```

---

## Task 9: Replace Provider RPCs with Unified Session RPC

**Objective:** Delete provider-specific RPC procedures and expose one SessionService-backed contract.

**Depends on:** Tasks 7 and 8.

**Paths:**

- `packages/contract/src/domain.ts`
- `packages/contract/src/session.ts`
- `packages/server/src/rpc/session.ts`
- `packages/server/src/rpc/context.ts`
- `packages/server/src/rpc/router.ts`
- `packages/server/src/rpc/handlers.ts`
- `packages/server/test/rpc-session.test.ts`

**Steps:**

- [x] Delete the `claudeCode` and `codex` contract/router namespaces.
- [x] Add create/resume/prompt/interrupt/close/events/snapshot/status/capabilities/respondToAgentRequest under `session`.
- [x] Route every operation directly through SessionService and EventBus.
- [x] Preserve Claude model and inspector parts.
- [x] Keep provider-native SDK values inside adapters.
- [x] Use Effect-derived Standard Schema views for session inputs and normalized outputs.
- [x] Make `@vibest/contract` own wire schemas; make harness depend on contract.
- [x] Add unified Codex-through-session RPC integration coverage.

**Verification:**

```bash
pnpm --filter @vibest/contract typecheck
pnpm --filter @vibest/server test
pnpm --filter @vibest/server typecheck
pnpm --filter @vibest/app typecheck
```

**Commit:**

```text
refactor(server): route agent rpc through session service
```

---

## Task 10: Explicit Runtime Ownership and Graceful Shutdown

**Objective:** Remove the module-global ManagedRuntime and make server creation/closure own all Effect resources.

**Depends on:** Task 9.

**Paths:**

- `packages/server/src/rpc/handlers.ts`
- `packages/server/src/rpc/index.ts`
- `packages/vibest/src/node/server.ts`
- `packages/vibest/src/node/cli.ts`
- `packages/vibest/src/node/server.test.ts`
- `apps/desktop/src/main/backend.ts`
- `apps/desktop/src/main/index.ts`
- Relevant desktop supervisor tests

**Steps:**

- [ ] Add async `createRpcRuntime()` returning handlers/context plus idempotent `dispose()`.
- [ ] Remove module-load runtime creation and `runSync(runtime.contextEffect)`.
- [ ] Make `createServer()` await the RPC runtime.
- [ ] Return a managed server handle or augment the server with an explicit async `dispose()` method.
- [ ] Define shutdown order:
  1. stop accepting HTTP/WS work;
  2. close active HTTP/WS connections;
  3. dispose Effect runtime;
  4. allow session/Codex finalizers to complete.
- [ ] Add SIGINT/SIGTERM handlers in CLI that await graceful disposal before exit.
- [ ] Ensure desktop supervisor SIGTERM reaches the CLI graceful path; keep SIGKILL fallback in supervisor timeout logic.
- [ ] Make repeated shutdown calls safe.
- [ ] Add tests proving Codex/Claude fake resources are finalized on server close.

**Verification:**

```bash
pnpm --filter @vibest/server test
pnpm --filter @vibest/cli test
pnpm --filter @vibest/cli typecheck
pnpm --filter desktop typecheck
```

**Commit:**

```text
refactor(server): own effect runtime in server lifecycle
```

---

## Task 11: Unified Client Subscription and Legacy Runtime Removal

**Objective:** Move the app to unified session subscribe/snapshot APIs, then remove Promise-based compatibility runtime classes.

**Depends on:** Task 10.

**Paths:**

- `packages/client/src/`
- `apps/app/src/core/chat/`
- `apps/app/src/components/chat/`
- `apps/app/src/lib/orpc.ts`
- `packages/harness/src/claude-code/agent.ts`
- `packages/harness/src/codex/agent.ts`
- `packages/harness/src/codex/app-server.ts`
- `packages/harness/src/utils/pushable.ts`
- Package exports and affected tests

**Steps:**

- [x] Add client subscription driver using unified event envelopes.
- [x] On live-stream gap, subscribe to a replacement stream before fetching snapshot.
- [x] Use snapshot cursor to ignore duplicate real-time frames.
- [x] Handle degraded mid-turn snapshot explicitly.
- [x] Route pending AgentRequests from control events.
- [x] Switch prompt calls to receipt-based submission rather than consuming a prompt-local server stream.
- [ ] Verify transcript/tool rendering remains unchanged through browser QA.
- [x] Remove old prompt/requestPermission client loops.
- [x] Remove old provider-specific RPC compatibility classes and routes.
- [x] Remove `Pushable` and its tests.
- [x] Remove old runtime exports from browser-facing subpaths.
- [x] Remove `legacyNative` after deleting the old capability RPC procedures.
- [ ] Restore cold persisted history after a full backend reconnect.

**Verification:**

```bash
pnpm --filter @vibest/harness test
pnpm --filter @vibest/server test
pnpm --filter @vibest/client test
pnpm --filter @vibest/client typecheck
pnpm --filter @vibest/app typecheck
pnpm --filter desktop test
```

Use browser QA to verify:

- Claude prompt and streaming;
- Codex prompt and streaming;
- permission allow/deny;
- interrupt;
- backend restart and snapshot recovery;
- forced subscriber overflow and gap recovery.

**Commit:**

```text
refactor(app): consume unified agent session events
```

---

## Task 12: Tool Schema Cleanup and Final Verification

**Objective:** Complete the Effect Schema migration for AI SDK tools, remove redundant Zod usage where safe, and run full regression verification.

**Depends on:** Task 11.

**Paths:**

- `packages/harness/src/claude-code/tools.ts`
- `packages/harness/src/codex/tools.ts`
- `packages/harness/package.json`
- `packages/contract/package.json`
- Tool type tests
- Design and plan docs if implementation decisions changed

**Steps:**

- [ ] Convert hand-written legacy tool schemas to Effect Schema.
- [ ] Pass all tool schemas through the shared `toStandardSchema` helper.
- [ ] For SDK-owned opaque tool types, choose explicitly per tool:
  - real Effect Schema;
  - declared trusted schema with a supplied JSON Schema annotation;
  - intentionally generic JSON object schema.
- [ ] Do not claim runtime validation for declaration-only schemas.
- [ ] Remove Zod from harness only if no harness source still imports it and bundle verification remains acceptable.
- [ ] Keep Zod in contract if unrelated procedures still use it; Standard Schema allows coexistence.
- [ ] Verify no Promise/AsyncGenerator leaks from runtime exports.
- [ ] Verify no direct `Effect.promise` wrappers remain in Agent RPC handlers.
- [ ] Verify no module-global ManagedRuntime remains.
- [ ] Verify no unbounded EventBus subscriber queue remains.
- [ ] Update the design document if implementation required a contract change.

**Full Verification:**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format
pnpm build
```

Also run:

```bash
rg -n "new Pushable|class Pushable|Effect\.promise\(\(\) => .*session|new ClaudeCodeAgent|new CodexAgent" packages apps
rg -n "PubSub\.unbounded" packages/server/src/events
rg -n "ManagedRuntime\.make" packages/server/src/rpc
```

Expected: no obsolete Agent runtime matches; any remaining `PubSub.unbounded` or `ManagedRuntime.make` must be outside the migrated ownership paths and explicitly justified.

**Commit:**

```text
refactor(harness): complete effect native agent migration
```

---

## Delivery Gates

A task cannot merge if any of the following is true:

- A new Effect resource is created without an owner Scope or finalizer.
- A shared build runs in an RPC caller Scope.
- A compatibility route changes its documented wire behavior without updating the design and client in the same delivery.
- A slow subscriber can block the publisher or grow memory without a configured limit.
- A gap can occur without a defined snapshot recovery result.
- A schema is duplicated in Zod and Effect Schema instead of sharing a Standard Schema view.
- A hot function recompiles a static Effect Schema decoder/encoder/guard.
- A new Effect test uses a manual runtime runner instead of `@effect/vitest` without testing an explicit boundary.
- A test uses a fixed sleep where a deterministic synchronization primitive is available.
- The task leaves a stub/fake at an integration seam that the task claims to connect.

## Final Done Criteria

The migration is complete when:

- Claude and Codex run through the same Effect-native adapter/session interface.
- SessionService exclusively owns active session state, construction, Scopes, pumps, and snapshots.
- Codex is lazy and restartable after crashes.
- Claude SDK permission callbacks are backed by scoped Deferreds.
- EventBus subscriptions are bounded and recover through snapshots.
- oRPC and AI SDK consume Effect Schema through `toStandardSchema`.
- Zod and Effect Schema coexist only where migration intentionally remains incomplete.
- Server shutdown disposes the Effect runtime and all child resources.
- The app uses unified session events rather than prompt-local AsyncGenerators.
- Full test, typecheck, lint, format, and build pass.
