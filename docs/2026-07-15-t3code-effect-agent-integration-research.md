# pingdotgg/t3code Effect Agent Integration Research

**Date:** 2026-07-15
**Source revision:** [`pingdotgg/t3code@3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31`](https://github.com/pingdotgg/t3code/tree/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31)
**Source date:** 2026-07-14
**Question:** How does T3 Code use Effect to integrate coding-agent runtimes, and which patterns should Vibest adopt or avoid in its Effect-native harness migration?

## Executive Summary

T3 Code is already Effect-native across its Agent stack. Its main pattern is:

```text
Effect Schema contracts
        │
        ▼
ProviderDriver (plain value + typed config schema)
        │ creates one scoped provider instance
        ▼
ProviderAdapter (Effect methods + Stream events)
        │
        ├── Claude SDK bridge
        │     Queue → Stream.toAsyncIterable
        │     AsyncIterable → Stream.fromAsyncIterable
        │     Deferred → permission/user-input callbacks
        │
        ├── Codex session runtime
        │     scoped ChildProcessSpawner
        │     typed Effect Codex app-server client
        │     Deferred → JSON-RPC and approval correlation
        │
        └── ACP session runtime
              typed Effect RPC protocol
              scoped process and fibers

ProviderInstanceRegistry
        │ owns one child Scope per provider instance
        ▼
ProviderService
        │ routes sessions and merges adapter event Streams
        ▼
ProviderRuntimeIngestion
        │ serial worker
        ▼
Persisted orchestration projection
        ▼
Effect RPC / HTTP / WebSocket server
```

The strongest confirmations for Vibest's current design are:

1. Agent-facing methods should return `Effect`; event output should be `Stream`.
2. Claude's Promise/AsyncIterable SDK should be isolated at the edge using Queue, Stream, Deferred, and a captured Effect Context.
3. Child processes and background fibers should be owned by explicit Scopes.
4. Effect Schema should define contracts, protocol payloads, and tagged errors.
5. Adapters can be plain captured values; only the registry/orchestration modules need Context service tags.
6. Session/provider routing should persist the provider/instance identity instead of guessing it from native session IDs.
7. Tests should use `@effect/vitest`, test Layers, and deterministic drain/barrier mechanisms.
8. The process entrypoint should launch one root Effect Layer rather than create a module-global runtime.

T3 Code should not be copied blindly in three areas:

1. It uses many unbounded Queue/PubSub structures. Vibest's bounded EventBus and terminal-gap design is safer for browser subscribers.
2. Codex uses one app-server process per session, while Vibest currently shares a lazy app-server transport. Changing topology during the migration would increase compatibility risk.
3. Session ownership is split between provider-local maps, ProviderService, and a persisted directory. Vibest's planned deep SessionService should keep one authoritative active-session owner.

## 1. Contract and Schema Architecture

T3 Code keeps shared contracts in a schema-only package. Agent runtime events are a discriminated Effect Schema union, and TypeScript types are derived from the schemas. Its RPC layer also uses Effect Schema directly through Effect RPC.

Sources:

- [`packages/contracts/src/providerRuntime.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/contracts/src/providerRuntime.ts)
- [`packages/contracts/src/rpc.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/contracts/src/rpc.ts#L237)
- [`packages/contracts/package.json`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/contracts/package.json)

Notable choices:

- `ProviderRuntimeEvent` is a large discriminated union covering session, thread, turn, item, content, request, task, hook, usage, warning, and error events.
- IDs and bounded numeric/domain values are branded or filtered schemas.
- Runtime events optionally include provider references and a raw native payload for diagnostics.
- RPC payload, success, error, and stream item schemas all come from Effect Schema.
- Tagged errors in protocol packages use `Schema.TaggedErrorClass`.

### Relevance to Vibest

This strongly supports making Effect Schema the source of truth for new harness DTOs and errors. Vibest still needs its Standard Schema adapter because it is retaining oRPC and AI SDK instead of adopting Effect RPC immediately.

T3 Code's `raw.payload: Schema.Unknown` is useful for diagnostics but is not a good default browser contract for Vibest. Vibest should retain native data server-side and expose normalized JSON-safe DTOs, with an explicitly scoped compatibility escape hatch for old Claude capability RPCs.

### Additional performance practice

T3 Code has a custom lint rule requiring compiled Schema decoders/encoders to be hoisted outside hot functions. The rule notes that `Schema.decodeUnknownEffect(schema)` and related APIs allocate compiled functions.

Source:

- [`oxlint-plugin-t3code/rules/no-inline-schema-compile.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/oxlint-plugin-t3code/rules/no-inline-schema-compile.ts)

Vibest should adopt this as a coding rule in the migration plan even if it does not add a custom Oxlint plugin immediately.

## 2. Provider Driver and Adapter Boundaries

T3 Code deliberately makes provider drivers and provider instances plain values rather than Context services. The singleton Effect service is the instance registry.

Source:

- [`apps/server/src/provider/ProviderDriver.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/ProviderDriver.ts#L1-L167)

Its adapter contract is close to Vibest's proposed Agent adapter:

```ts
interface ProviderAdapterShape<TError> {
  readonly startSession: (...) => Effect.Effect<ProviderSession, TError>;
  readonly sendTurn: (...) => Effect.Effect<ProviderTurnStartResult, TError>;
  readonly interruptTurn: (...) => Effect.Effect<void, TError>;
  readonly respondToRequest: (...) => Effect.Effect<void, TError>;
  readonly stopSession: (...) => Effect.Effect<void, TError>;
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
```

Source:

- [`apps/server/src/provider/Services/ProviderAdapter.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Services/ProviderAdapter.ts)

Each driver `create()` captures typed per-instance configuration and returns a bundle containing snapshot, adapter, and text-generation services. This supports multiple independent instances of the same provider without singleton Context tags.

Sources:

- [`apps/server/src/provider/Drivers/CodexDriver.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Drivers/CodexDriver.ts)
- [`apps/server/src/provider/Drivers/ClaudeDriver.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Drivers/ClaudeDriver.ts)

### Relevance to Vibest

Vibest should keep `HarnessAgentAdapter` as a plain interface/value selected by `HarnessAgentRegistry`. There is no need for one Context tag per provider. A Context service is useful for the registry and deep SessionService because those are singleton ownership modules.

## 3. Scope Ownership and Provider Instance Registry

T3 Code creates a fresh child Scope for every materialized provider instance. The registry stores `{ instance, scope, config }`, closes the old scope before replacing an instance, and attaches every child scope to the registry's parent scope.

Source:

- [`apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts#L119-L210)

Important details:

- Raw provider config is decoded once through the driver's Effect Schema.
- Unknown drivers and invalid configs become unavailable snapshots rather than defects.
- A changed instance is closed before its replacement is built.
- Registry shutdown closes all instance scopes.
- The registry captures both its parent Scope and driver dependency Context so later hot-reload calls do not accidentally inherit an RPC caller's Scope.

### Relevance to Vibest

This validates Vibest's explicit child-Scope ownership and the requirement that delayed operations capture their long-lived owner Context/Scope at construction time.

T3 Code owns scopes at provider-instance level and again inside adapters at session level. Vibest's initial migration can be simpler: SessionService owns active session child scopes; Codex transport has a transport child scope; adapters should not expose an independent session manager.

## 4. Claude Agent SDK Integration

T3 Code's Claude adapter is the closest implementation reference for Vibest.

Source:

- [`apps/server/src/provider/Layers/ClaudeAdapter.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ClaudeAdapter.ts)

### 4.1 Input bridge

For each session, T3 Code creates an Effect Queue, turns it into a Stream, filters message entries, and converts the Stream to the SDK-required AsyncIterable using `Stream.toAsyncIterable`.

Relevant source:

- [`ClaudeAdapter.ts#L3070-L3110`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3070-L3110)

This is the same bridge proposed for Vibest:

```text
Effect Queue<UserInput>
  → Stream.fromQueue
  → Stream.toAsyncIterable
  → Anthropic query({ prompt })
```

### 4.2 Output bridge

The SDK query object remains an AsyncIterable only at the SDK seam. T3 converts it immediately with `Stream.fromAsyncIterable`, then handles each native message in an Effect stream pipeline.

Relevant source:

- [`ClaudeAdapter.ts#L2887-L2910`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2887-L2910)

### 4.3 Promise callback bridge

The Anthropic `canUseTool` callback must return a Promise. T3 captures the session construction Context and creates `runPromiseWith(context)` and `runForkWith(context)` runners. The callback itself only invokes the captured runner around an Effect program.

Relevant source:

- [`ClaudeAdapter.ts#L3095-L3100`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3095-L3100)
- [`ClaudeAdapter.ts#L3300-L3380`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3300-L3380)

This prevents SDK callbacks from running on an unrelated global runtime.

### 4.4 Interactive requests

Permissions and structured user-input requests use Deferreds. The SDK callback:

1. allocates a request id and Deferred;
2. publishes a normalized request event;
3. stores pending state;
4. attaches an AbortSignal listener;
5. awaits the Deferred;
6. maps the domain answer back to the SDK wire result.

The public adapter's `respondToRequest` / `respondToUserInput` methods complete those Deferreds.

Relevant source:

- [`ClaudeAdapter.ts#L3120-L3380`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3120-L3380)
- [`ClaudeAdapter.ts#L3760-L3810`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3760-L3810)

### 4.5 Turn receipt and per-turn model

T3 allocates a turn id before Queue submission, emits `turn.started`, applies `query.setModel(...)` before enqueueing the message, and returns `{ threadId, turnId, resumeCursor }`.

Relevant source:

- [`ClaudeAdapter.ts#L3600-L3740`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3600-L3740)

This directly validates Vibest's revised `PromptReceipt { turnId, cursor }` and requirement to preserve per-turn model selection.

### 4.6 Shutdown

T3's session stop path:

- marks the session stopped;
- completes pending approvals with cancel;
- closes the active turn;
- shuts down the prompt Queue;
- interrupts the stream fiber;
- calls the SDK query's `close()`;
- updates session state and emits exit events.

The adapter registers a finalizer that stops all sessions and shuts down its event Queue.

Relevant source:

- [`ClaudeAdapter.ts#L2940-L3030`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2940-L3030)
- [`ClaudeAdapter.ts#L3820-L3850`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3820-L3850)

### Differences from Vibest's target

- T3 uses unbounded prompt and event queues.
- T3 keeps a mutable session Map inside the adapter.
- Its Claude adapter is very large and combines SDK integration, lifecycle, event normalization, snapshots, tool classification, and diagnostics.

Vibest should reuse the boundary patterns but keep the SDK adapter thinner and move active-session ownership/projection to SessionService.

## 5. Codex App-Server Integration

T3 Code extracted a dedicated `effect-codex-app-server` package.

Sources:

- [`packages/effect-codex-app-server/src/client.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/effect-codex-app-server/src/client.ts)
- [`packages/effect-codex-app-server/src/protocol.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/effect-codex-app-server/src/protocol.ts)
- [`packages/effect-codex-app-server/src/errors.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/effect-codex-app-server/src/errors.ts)
- [`packages/effect-codex-app-server/src/_generated/schema.gen.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/effect-codex-app-server/src/_generated/schema.gen.ts)

### 5.1 Typed protocol package

The package separates:

- generated Effect Schemas and request/response method maps;
- a raw JSONL protocol;
- typed request/notification handlers;
- typed tagged errors;
- child-process Stdio adaptation.

The public client exposes typed request signatures keyed by method name, while retaining a `raw` escape hatch.

### 5.2 JSON-RPC correlation

The protocol uses:

- Ref for the pending request Map and request counter;
- Deferred for each pending response;
- queue-backed stdout writing;
- scoped stdin reader and stdout writer fibers;
- termination handling that fails every pending Deferred exactly once;
- pending cleanup on send failure and caller interruption.

Relevant source:

- [`protocol.ts#L151-L430`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/effect-codex-app-server/src/protocol.ts#L151-L430)

This validates most of Vibest's proposed CodexTransport internals.

### 5.3 Effect process integration

T3 uses `effect/unstable/process/ChildProcessSpawner` and scoped process handles rather than wrapping Node's `spawn` directly. The handle exposes Effect Streams/Sinks for stdio and an Effect exit status. `forceKillAfter` configures the kill fallback.

Relevant source:

- [`apps/server/src/provider/Layers/CodexSessionRuntime.ts#L695-L755`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L695-L755)
- [`packages/effect-codex-app-server/src/_internal/stdio.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/effect-codex-app-server/src/_internal/stdio.ts)

Vibest's installed Effect v4 beta.97 still exposes these APIs, and [`@effect/platform-node@4.0.0-beta.97`](https://www.npmjs.com/package/@effect/platform-node/v/4.0.0-beta.97) is published. This should be evaluated before implementing a manual `Effect.acquireRelease(spawn, kill)` wrapper.

### 5.4 Session process topology

T3 starts one Codex app-server process per active Codex session. `makeCodexSessionRuntime` spawns the process, initializes the client, opens/resumes one thread, and owns its event queues/fibers. `makeCodexAdapter` gives every session a child Scope and stores the runtime in a session Map.

Sources:

- [`CodexSessionRuntime.ts#L695-L1260`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L695-L1260)
- [`CodexAdapter.ts#L1348-L1690`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/CodexAdapter.ts#L1348-L1690)

Consequences:

- Codex is lazy at session start.
- A process crash affects only one session.
- A subsequent `startSession` creates a fresh process.
- There is no shared transport generation state.
- Multiple sessions consume more processes and memory.

Vibest currently shares one Codex app-server and has an explicit compatibility requirement to preserve current behavior. The migration should retain the shared lazy transport unless a separate measured change intentionally adopts per-session processes.

### 5.5 Restart semantics

T3 does not transparently restart a crashed active Codex session. Process exit emits a session exit/error event; future recovery calls create a new session runtime and process. This is simpler than Vibest's generation-safe shared transport holder.

Vibest's restart requirement is stronger and still needs the planned `Idle | Starting | Running` holder with a build fiber owned by the adapter Scope.

## 6. ACP Integration as a Second Protocol Reference

T3 also contains a reusable `effect-acp` package. It uses Effect's unstable RPC client/server APIs over an NDJSON Stdio protocol, generated Effect Schemas, tagged errors, and scoped fibers.

Sources:

- [`packages/effect-acp/src/client.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/effect-acp/src/client.ts)
- [`packages/effect-acp/src/protocol.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/effect-acp/src/protocol.ts)
- [`apps/server/src/provider/acp/AcpSessionRuntime.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/acp/AcpSessionRuntime.ts)

Useful patterns:

- Protocol transport is separate from session lifecycle.
- The client exposes Effect methods and handler registration Effects.
- Session startup uses explicit `NotStarted | Starting | Started` state and a Deferred.
- Prompts are serialized with a Semaphore.
- Prompt work runs in a runtime Scope fiber.
- `drainEvents` inserts a barrier with a Deferred instead of sleeping.

Relevant source:

- [`AcpSessionRuntime.ts#L647-L760`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/acp/AcpSessionRuntime.ts#L647-L760)

Caution: ACP's first startup caller still executes the startup Effect directly. Vibest's reviewed design is safer because the shared build is always forked into the long-lived owner Scope, so caller cancellation cannot interrupt construction for other waiters.

## 7. Session Routing, Recovery, and Persistence

T3 Code persists a routing binding containing:

- thread id;
- provider driver;
- provider instance id;
- runtime mode;
- status;
- resume cursor;
- runtime payload;
- last-seen timestamp.

Source:

- [`apps/server/src/provider/Layers/ProviderSessionDirectory.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ProviderSessionDirectory.ts)

ProviderService uses this directory to:

- route a thread to the correct provider instance;
- adopt an already-active session;
- recover a missing active session from persisted resume state;
- update the binding after session/turn operations;
- avoid inferring provider identity from a native session id.

Source:

- [`apps/server/src/provider/Layers/ProviderService.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ProviderService.ts)

### Relevance to Vibest

This supports Vibest's revised decision to pass `harnessAgentId` explicitly on cold resume rather than parse current Claude/Codex native ids. Longer term, Vibest should persist `{ sessionId, harnessAgentId, resumeCursor }` as one routing record.

T3's active-session ownership is more distributed than Vibest's target: adapters own Maps, ProviderService tracks subscribed adapters, and ProviderSessionDirectory persists bindings. Vibest should keep only persistence outside SessionService; active instances and construction single-flight should remain private to SessionService.

## 8. Canonical Event Ingestion and Snapshot Recovery

Provider adapters emit canonical `ProviderRuntimeEvent` values. ProviderService merges all live adapter Streams into one runtime PubSub. A scoped subscription fiber is created for every provider instance and exits when the provider instance Scope closes.

Source:

- [`apps/server/src/provider/Layers/ProviderService.ts#L202-L360`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/ProviderService.ts#L202-L360)

ProviderRuntimeIngestion consumes this stream through a serial drainable worker and projects events into persisted orchestration state. The UI reads persisted snapshots and subscribes to orchestration changes instead of rebuilding directly from native events.

Sources:

- [`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1630-L1720`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1630-L1720)
- [`packages/shared/src/DrainableWorker.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/shared/src/DrainableWorker.ts)

### Relevance to Vibest

T3 validates separating:

1. native event normalization;
2. event transport;
3. state projection;
4. snapshot query.

Vibest's SessionService event pump + active-turn projection is a smaller in-memory version of this architecture. It is appropriate for the current migration and can later feed persistence.

T3 does not provide a model to copy for bounded browser delivery: its adapter queues, runtime PubSub, protocol queues, and drainable worker are generally unbounded. Vibest should keep its bounded subscriber queues and terminal-gap recovery contract.

## 9. Root Runtime and Server Ownership

T3 Code's entire server is an Effect Layer graph. HTTP, WebSocket RPC, provider runtimes, persistence, background reactors, and platform services are composed into `makeServerLayer`. `runServer` is `Layer.launch(makeServerLayer)`, and the CLI entrypoint runs the scoped program through `NodeRuntime.runMain`.

Sources:

- [`apps/server/src/server.ts#L346-L493`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/server.ts#L346-L493)
- [`apps/server/src/bin.ts#L52-L61`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/bin.ts#L52-L61)

This means process signals and root program completion close the root Scope and run all child finalizers. There is no module-global ManagedRuntime serving as an accidental process singleton.

### Relevance to Vibest

Vibest's oRPC/Express integration makes a full server rewrite inappropriate during this migration. The equivalent incremental pattern is:

- async `createRpcRuntime()`;
- one explicit owner per HTTP server;
- idempotent async dispose;
- CLI signal handlers that await disposal;
- root Scope closure cascading into SessionService, adapters, transports, and child sessions.

## 10. Testing Practices

T3 Code standardizes on `@effect/vitest` and Layer-based tests. It has a lint rule preventing new `Effect.runPromise`, `Effect.runSync`, and `ManagedRuntime.make` calls in tests, with a tracked allowlist for legacy debt.

Sources:

- [`oxlint-plugin-t3code/rules/no-manual-effect-runtime-in-tests.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/oxlint-plugin-t3code/rules/no-manual-effect-runtime-in-tests.ts)
- [`apps/server/src/provider/Layers/CodexAdapter.test.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/Layers/CodexAdapter.test.ts)
- [`packages/effect-codex-app-server/src/client.test.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/effect-codex-app-server/src/client.test.ts)

It also creates deterministic synchronization points:

- `DrainableWorker.drain` tracks outstanding work transactionally.
- ACP `drainEvents` inserts an event-stream barrier carrying a Deferred.
- Test-only receipt buses expose internal milestones without polluting production behavior.

Sources:

- [`packages/shared/src/DrainableWorker.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/packages/shared/src/DrainableWorker.ts)
- [`apps/server/src/provider/acp/AcpSessionRuntime.ts#L697-L704`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/provider/acp/AcpSessionRuntime.ts#L697-L704)
- [`apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts`](https://github.com/pingdotgg/t3code/blob/3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31/apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts)

### Relevance to Vibest

Add `@effect/vitest@4.0.0-beta.97` and use `it.effect` / `it.layer` for new runtime tests. Existing Vitest tests can remain during migration, but new Effect modules should not add manual runtime runners unless the test explicitly verifies a Promise boundary.

## 11. Recommended Changes to the Vibest Plan

### Adopt now

1. **Use `@effect/vitest` for new Effect runtime tests.**
2. **Hoist compiled Schema validators/decoders to module scope.**
3. **Spike `@effect/platform-node` and `effect/unstable/process` before writing manual child-process wrappers.**
4. **Keep provider adapters as plain values; use Context services for Registry and SessionService.**
5. **Capture long-lived Context/Scope when a service is built and provide it explicitly to delayed/hot-reload operations.**
6. **Add deterministic event-pump drain/barrier helpers for tests and close sequencing.**
7. **Persist explicit agent routing metadata instead of deriving it from native session ids.**
8. **Keep protocol transport, provider session runtime, event normalization, and session orchestration as separate modules.**

### Keep the current Vibest design instead of copying T3

1. **Keep bounded EventBus subscriber queues and terminal gaps.**
2. **Keep one authoritative active-session map in SessionService.**
3. **Keep shared Codex app-server topology during the compatibility migration.**
4. **Keep native payloads out of the new browser wire contract by default.**
5. **Keep oRPC + Standard Schema for incremental migration rather than rewriting transport to Effect RPC now.**
6. **Run shared transport/session construction in owner-scope fibers, not the first caller fiber.**

### Consider later

1. Extract a reusable typed `effect-codex-app-server`-style package if Codex support expands beyond the harness.
2. Generate Effect Schemas from Codex's protocol source rather than manually maintaining request/response schemas.
3. Replace the in-memory SessionService projection with a persisted event-sourced projection if cross-process replay and durable reconnect become requirements.
4. Evaluate process-per-session Codex isolation separately, with memory/latency measurements and explicit compatibility work.

## 12. Final Assessment

T3 Code substantially validates the direction of Vibest's Effect-native harness design, especially for Claude's SDK bridge, scoped resource ownership, Effect Schema contracts, plain adapter values, typed errors, and deterministic testing.

The main architectural difference is ownership depth. T3 Code has evolved into several overlapping ownership layers because it supports many providers, multiple configured instances, hot reload, persistence, and event-sourced orchestration. Vibest should borrow the boundary techniques without reproducing that complexity prematurely.

The highest-value concrete adjustment is to evaluate Effect's own ChildProcessSpawner before implementing Codex transport over raw Node callbacks. The second is to adopt `@effect/vitest` plus explicit drain/barrier synchronization from the first migration task. The current deep SessionService, shared-build cancellation isolation, bounded EventBus, and Standard Schema seam should remain unchanged.
