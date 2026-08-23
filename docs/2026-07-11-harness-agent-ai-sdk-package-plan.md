# Harness Agent — ai-sdk Abstraction Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two-plane ai-sdk abstraction (envelope + `defineEvent` events + per-backend transform/fold) to the existing `ai-sdk-agents` package, additively, without renaming it or touching any consumer.

**Architecture:** Pure-TS layer over the Vercel AI SDK. A session's live stream is one envelope union whose `body` is either an AI-SDK `UIMessageChunk` (render plane, hyphenated `type`) or a `defineEvent` control event (dotted `type`); the two are told apart by `isSessionEvent(body) = body.type.includes(".")` — no `kind` tag. Claude-code native `SDKMessage`s map to render chunks via `transform` and to control events via `toSessionEvent`; `foldToUIMessages` folds the same `transform` output into `UIMessage[]` so cold history and the live stream are structurally identical. No event-sourcing, no `scope`/`droppable` fields.

**Tech Stack:** TypeScript, Vercel AI SDK (`ai` ^7.0.22: `UIMessage`, `InferUIMessageChunk`, `InferUITools`, `readUIMessageStream` — all unchanged from v5), Zod (`zod/v4`), Vitest (`vp test`).

**Prerequisite:** the monorepo must be on `ai` v7 first — run `docs/2026-07-11-ai-sdk-v7-upgrade-plan.md` before this plan. Every AI-SDK symbol this plan uses is identical in v7; the only v7 breakage (provider `tool()` shape) is handled by that upgrade plan, not here.

**Design source:** `docs/2026-07-11-harness-agent-adapter-ai-sdk-design.md` (§2 layering, §3 ai-sdk abstraction). This plan implements the `@vibest/ai-sdk-harness-agents` half of §2, minus the rename.

## Global Constraints

- **Additive only, no rename:** work inside the existing `packages/ai-sdk-agents` package. Do **NOT** rename it to `ai-sdk-harness-agents`, and do **NOT** edit any consumer (`packages/server-rpc`, `packages/ui`, `packages/vibest`, `packages/vibest-devtools-client`, `packages/agents`). The rename + consumer migration + old-export cleanup are a separate later plan.
- **Zod import path is `zod/v4`** (matches all existing files in this package) — never bare `zod`.
- **Event naming invariant:** every `defineEvent` `type` is `namespace.action`, all-lowercase, `.`-separated, and its last segment is one of the reserved past-tense verbs: `created`, `updated`, `deleted`, `renamed`, `started`, `ended`, `asked`, `replied`, `rejected`, `crashed`, `failed`, `exited`, `connected`, `disconnected`. Every event `type` therefore contains at least one `.`. AI-SDK chunk `type`s never contain a `.`.
- **No `kind`, no `scope`, no `droppable`, no event-sourcing.** Routing is `isSessionEvent`; delivery/seq/snapshot belong to the server slice (out of scope here).
- **`HarnessAgentId = "claude-code" | "codex"`.** Codex gets type-only placeholders this round; no codex runtime.
- **Tests:** Vitest, node env, config already at `packages/ai-sdk-agents/vitest.config.ts`. Runtime tests live under `packages/ai-sdk-agents/test/**/*.test.ts` (importing from `../../src/...`), matching the package's existing `test/` convention; type-level tests are `*.test-d.ts`. Run the package suite with `pnpm --filter ai-sdk-agents test`.
- **Preflight (execution skill handles):** commit the pending design-doc edits, then create branch `feat/harness-agent-ai-sdk` from HEAD. Commits use conventional-commit style with **no Claude annotations**.

---

### Task 1: Event primitive + shared schemas

**Files:**

- Create: `packages/ai-sdk-agents/src/types/harness-agent-id.ts`
- Create: `packages/ai-sdk-agents/src/types/event.ts`
- Test: `packages/ai-sdk-agents/test/types/event.test.ts`

**Interfaces:**

- Produces: `HarnessAgentId` (type) + `HarnessAgentIdSchema` (`z.ZodEnum`); `defineEvent<T, S>({ type, schema }): EventDef<T, S>`; `EventDef<T, S>` (`{ type: T; schema: z.ZodObject<S> }`); `EventValue<D>` (`{ type } & z.infer`); `TokenUsageSchema`/`TokenUsage`; `TurnErrorSchema`/`TurnError`; `TurnErrorCategory`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ai-sdk-agents/test/types/event.test.ts
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { defineEvent, TokenUsageSchema, TurnErrorSchema } from "../../src/types/event";

describe("defineEvent", () => {
  it("carries the literal type and a validating object schema", () => {
    const Ended = defineEvent({
      type: "session.turn.ended",
      schema: { turnId: z.string(), outcome: z.enum(["completed", "failed", "canceled"]) },
    });
    expect(Ended.type).toBe("session.turn.ended");
    expect(Ended.schema.parse({ turnId: "t1", outcome: "completed" })).toEqual({
      turnId: "t1",
      outcome: "completed",
    });
    expect(() => Ended.schema.parse({ turnId: 1, outcome: "completed" })).toThrow();
  });
});

describe("shared schemas", () => {
  it("parses token usage with optional cache fields", () => {
    expect(TokenUsageSchema.parse({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it("rejects an unknown turn-error category", () => {
    expect(() => TurnErrorSchema.parse({ message: "x", category: "nope" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ai-sdk-agents test`
Expected: FAIL — cannot resolve `../../src/types/event`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/ai-sdk-agents/src/types/harness-agent-id.ts
import { z } from "zod/v4";

export const HarnessAgentIdSchema = z.enum(["claude-code", "codex"]);
export type HarnessAgentId = z.infer<typeof HarnessAgentIdSchema>;
```

```ts
// packages/ai-sdk-agents/src/types/event.ts
import { z } from "zod/v4";

/** A control-plane event definition: a dotted `type` + a zod object schema for its properties. */
export interface EventDef<T extends string = string, S extends z.ZodRawShape = z.ZodRawShape> {
  readonly type: T;
  readonly schema: z.ZodObject<S>;
}

/** The wire value of an event: a flat tagged object (same shape family as a UIMessageChunk). */
export type EventValue<D extends EventDef> =
  D extends EventDef<infer T, infer S> ? { type: T } & z.infer<z.ZodObject<S>> : never;

export function defineEvent<const T extends string, S extends z.ZodRawShape>(def: {
  type: T;
  schema: S;
}): EventDef<T, S> {
  return { type: def.type, schema: z.object(def.schema) };
}

export const TokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const TurnErrorCategorySchema = z.enum([
  "auth_expired",
  "rate_limited",
  "context_overflow",
  "model_unavailable",
  "network",
  "cancelled",
  "unknown",
]);
export type TurnErrorCategory = z.infer<typeof TurnErrorCategorySchema>;

export const TurnErrorSchema = z.object({
  message: z.string(),
  category: TurnErrorCategorySchema,
  retryAfterMs: z.number().optional(),
});
export type TurnError = z.infer<typeof TurnErrorSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ai-sdk-agents test`
Expected: PASS (4 assertions across the two `describe` blocks).

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-agents/src/types/harness-agent-id.ts packages/ai-sdk-agents/src/types/event.ts packages/ai-sdk-agents/test/types/event.test.ts
git commit -m "feat(ai-sdk-agents): add defineEvent primitive and shared event schemas"
```

---

### Task 2: Agent request/response schemas

**Files:**

- Create: `packages/ai-sdk-agents/src/types/request.ts`
- Test: `packages/ai-sdk-agents/test/types/request.test.ts`

**Interfaces:**

- Consumes: `HarnessAgentIdSchema` (Task 1).
- Produces: `AgentRequestSchema`/`AgentRequest` (discriminated union `tool | question | plan`); `AgentResponseSchema`/`AgentResponse`; `AgentRequestActionSchema`, `AgentRequestQuestionSchema`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ai-sdk-agents/test/types/request.test.ts
import { describe, expect, it } from "vitest";
import { AgentRequestSchema, AgentResponseSchema } from "../../src/types/request";

describe("AgentRequest", () => {
  it("parses a tool request", () => {
    const req = {
      type: "tool",
      id: "r1",
      harnessAgentId: "claude-code",
      toolName: "Bash",
      input: { command: "ls" },
      actions: [{ id: "allow", label: "Allow" }],
      native: { any: "thing" },
    };
    expect(AgentRequestSchema.parse(req).type).toBe("tool");
  });

  it("rejects a request with an unknown discriminant", () => {
    expect(() => AgentRequestSchema.parse({ type: "mystery", id: "x" })).toThrow();
  });
});

describe("AgentResponse", () => {
  it("parses a tool allow/deny response", () => {
    expect(AgentResponseSchema.parse({ type: "tool", behavior: "allow" }).type).toBe("tool");
    expect(() => AgentResponseSchema.parse({ type: "tool", behavior: "maybe" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ai-sdk-agents test`
Expected: FAIL — cannot resolve `../../src/types/request`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/ai-sdk-agents/src/types/request.ts
import { z } from "zod/v4";
import { HarnessAgentIdSchema } from "./harness-agent-id";

export const AgentRequestActionSchema = z.object({
  id: z.string(),
  label: z.string(),
});
export type AgentRequestAction = z.infer<typeof AgentRequestActionSchema>;

export const AgentRequestQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
});
export type AgentRequestQuestion = z.infer<typeof AgentRequestQuestionSchema>;

export const AgentRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool"),
    id: z.string(),
    harnessAgentId: HarnessAgentIdSchema,
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
    actions: z.array(AgentRequestActionSchema),
    native: z.unknown(),
  }),
  z.object({
    type: z.literal("question"),
    id: z.string(),
    harnessAgentId: HarnessAgentIdSchema,
    questions: z.array(AgentRequestQuestionSchema),
    native: z.unknown(),
  }),
  z.object({
    type: z.literal("plan"),
    id: z.string(),
    harnessAgentId: HarnessAgentIdSchema,
    plan: z.string(),
    native: z.unknown(),
  }),
]);
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export const AgentResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool"),
    behavior: z.enum(["allow", "deny"]),
    message: z.string().optional(),
    native: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("question"),
    answers: z.array(
      z.object({
        questionId: z.string(),
        values: z.array(z.string()),
        other: z.string().optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal("plan"),
    behavior: z.enum(["allow", "deny"]),
    native: z.unknown().optional(),
  }),
]);
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ai-sdk-agents test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-agents/src/types/request.ts packages/ai-sdk-agents/test/types/request.test.ts
git commit -m "feat(ai-sdk-agents): add agent request/response schemas"
```

---

### Task 3: Session events + central manifest

**Files:**

- Create: `packages/ai-sdk-agents/src/events/session.ts`
- Create: `packages/ai-sdk-agents/src/event-manifest.ts`
- Test: `packages/ai-sdk-agents/test/event-manifest.test.ts`

**Interfaces:**

- Consumes: `defineEvent`, `TokenUsageSchema`, `TurnErrorSchema` (Task 1); `AgentRequestSchema` (Task 2); `HarnessAgentIdSchema` (Task 1).
- Produces: named event defs (`SessionTurnStarted`, `SessionTurnEnded`, `SessionRequestAsked`, `SessionRequestReplied`, `SessionRequestRejected`, `SessionCrashed`, `SessionCreated`, `SessionUpdated`, `SessionDeleted`, `SessionRenamed`, `ProjectUpdated`, `PtyCreated`, `PtyUpdated`, `PtyExited`, `ProviderUpdated`, `McpUpdated`, `ServerConnected`, `ServerDisconnected`); `SessionEventDefs`, `GlobalEventDefs` (readonly arrays); `SessionEvent`, `GlobalEvent` (union value types).

- [ ] **Step 1: Write the failing test**

```ts
// packages/ai-sdk-agents/test/event-manifest.test.ts
import { describe, expect, it } from "vitest";
import { GlobalEventDefs, SessionEventDefs } from "../src/event-manifest";

const RESERVED_VERBS = new Set([
  "created",
  "updated",
  "deleted",
  "renamed",
  "started",
  "ended",
  "asked",
  "replied",
  "rejected",
  "crashed",
  "failed",
  "exited",
  "connected",
  "disconnected",
]);

describe("event manifest naming invariant", () => {
  const all = [...SessionEventDefs, ...GlobalEventDefs];

  it("every event type is dotted namespace.action", () => {
    for (const def of all) expect(def.type).toContain(".");
  });

  it("every event type ends in a reserved past-tense verb", () => {
    for (const def of all) {
      const verb = def.type.split(".").at(-1);
      expect(RESERVED_VERBS.has(verb ?? "")).toBe(true);
    }
  });

  it("every event type is unique", () => {
    const types = all.map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("includes the v1 session-scoped catalog", () => {
    const types = SessionEventDefs.map((d) => d.type);
    expect(types).toContain("session.turn.started");
    expect(types).toContain("session.turn.ended");
    expect(types).toContain("session.request.asked");
    expect(types).toContain("session.crashed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ai-sdk-agents test`
Expected: FAIL — cannot resolve `../src/event-manifest`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/ai-sdk-agents/src/events/session.ts
import { z } from "zod/v4";
import { defineEvent, TokenUsageSchema, TurnErrorSchema } from "../types/event";
import { AgentRequestSchema } from "../types/request";
import { HarnessAgentIdSchema } from "../types/harness-agent-id";

const sid = { sessionId: z.string() };

// —— session-scoped (per-session stream) ——
export const SessionTurnStarted = defineEvent({
  type: "session.turn.started",
  schema: { ...sid, turnId: z.string() },
});
export const SessionTurnEnded = defineEvent({
  type: "session.turn.ended",
  schema: {
    ...sid,
    turnId: z.string(),
    outcome: z.enum(["completed", "failed", "canceled"]),
    usage: TokenUsageSchema.optional(),
    error: TurnErrorSchema.optional(),
  },
});
export const SessionRequestAsked = defineEvent({
  type: "session.request.asked",
  schema: { ...sid, request: AgentRequestSchema },
});
export const SessionRequestReplied = defineEvent({
  type: "session.request.replied",
  schema: { ...sid, requestId: z.string() },
});
export const SessionRequestRejected = defineEvent({
  type: "session.request.rejected",
  schema: { ...sid, requestId: z.string(), reason: z.string().optional() },
});
export const SessionCrashed = defineEvent({
  type: "session.crashed",
  schema: { ...sid, reason: z.string() },
});

// —— global (session collection + other business modules) ——
export const SessionCreated = defineEvent({
  type: "session.created",
  schema: { sessionId: z.string(), harnessAgentId: HarnessAgentIdSchema },
});
export const SessionUpdated = defineEvent({
  type: "session.updated",
  schema: { sessionId: z.string() },
});
export const SessionDeleted = defineEvent({
  type: "session.deleted",
  schema: { sessionId: z.string() },
});
export const SessionRenamed = defineEvent({
  type: "session.renamed",
  schema: { sessionId: z.string(), title: z.string() },
});
export const ProjectUpdated = defineEvent({
  type: "project.updated",
  schema: { projectId: z.string() },
});
export const PtyCreated = defineEvent({ type: "pty.created", schema: { ptyId: z.string() } });
export const PtyUpdated = defineEvent({ type: "pty.updated", schema: { ptyId: z.string() } });
export const PtyExited = defineEvent({
  type: "pty.exited",
  schema: { ptyId: z.string(), exitCode: z.number().optional() },
});
export const ProviderUpdated = defineEvent({
  type: "provider.updated",
  schema: { providerId: z.string() },
});
export const McpUpdated = defineEvent({ type: "mcp.updated", schema: { serverId: z.string() } });
export const ServerConnected = defineEvent({ type: "server.connected", schema: {} });
export const ServerDisconnected = defineEvent({ type: "server.disconnected", schema: {} });
```

```ts
// packages/ai-sdk-agents/src/event-manifest.ts
import type { EventValue } from "./types/event";
import * as S from "./events/session";

/** Session-scoped events (control plane carried on a session envelope). */
export const SessionEventDefs = [
  S.SessionTurnStarted,
  S.SessionTurnEnded,
  S.SessionRequestAsked,
  S.SessionRequestReplied,
  S.SessionRequestRejected,
  S.SessionCrashed,
] as const;
export type SessionEvent = EventValue<(typeof SessionEventDefs)[number]>;

/** Global events (session collection + other business modules). */
export const GlobalEventDefs = [
  S.SessionCreated,
  S.SessionUpdated,
  S.SessionDeleted,
  S.SessionRenamed,
  S.ProjectUpdated,
  S.PtyCreated,
  S.PtyUpdated,
  S.PtyExited,
  S.ProviderUpdated,
  S.McpUpdated,
  S.ServerConnected,
  S.ServerDisconnected,
] as const;
export type GlobalEvent = EventValue<(typeof GlobalEventDefs)[number]>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ai-sdk-agents test`
Expected: PASS (naming invariant + uniqueness + catalog membership).

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-agents/src/events/session.ts packages/ai-sdk-agents/src/event-manifest.ts packages/ai-sdk-agents/test/event-manifest.test.ts
git commit -m "feat(ai-sdk-agents): add session/global event definitions and manifest"
```

---

### Task 4: UIMessage types + envelope + `isSessionEvent`

**Files:**

- Create: `packages/ai-sdk-agents/src/claude-code/ui-message.ts`
- Create: `packages/ai-sdk-agents/src/codex/ui-message.ts`
- Create: `packages/ai-sdk-agents/src/types/envelope.ts`
- Test: `packages/ai-sdk-agents/test/types/envelope.test.ts`

**Interfaces:**

- Consumes: `ClaudeCodeTools` (existing `src/claude-code/index.ts`); `SessionEvent` (Task 3); `HarnessAgentId` (Task 1).
- Produces: `ClaudeCodeUIMessage`/`ClaudeCodeMetadata`/`ClaudeCodeDataTypes`; `CodexUIMessage`/`CodexMetadata`/`CodexDataTypes`/`CodexTools` (placeholders); `ClaudeCodeUIMessageChunk`, `CodexUIMessageChunk`; `SessionEnvelopeBody`, `SessionEnvelope`, `SessionEnvelopeDraft`; `isSessionEvent(body): body is SessionEvent`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ai-sdk-agents/test/types/envelope.test.ts
import { describe, expect, it } from "vitest";
import { isSessionEvent } from "../../src/types/envelope";

describe("isSessionEvent", () => {
  it("routes dotted event types to the control plane", () => {
    for (const type of [
      "session.turn.started",
      "session.turn.ended",
      "session.request.asked",
      "project.updated",
      "server.connected",
    ]) {
      expect(isSessionEvent({ type } as never)).toBe(true);
    }
  });

  it("routes AI-SDK chunk types to the render plane", () => {
    for (const type of [
      "start",
      "finish",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-available",
      "tool-output-available",
      "tool-output-error",
      "data-custom",
      "reasoning-delta",
    ]) {
      expect(isSessionEvent({ type } as never)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ai-sdk-agents test`
Expected: FAIL — cannot resolve `../../src/types/envelope`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/ai-sdk-agents/src/claude-code/ui-message.ts
import type { UIMessage } from "ai";
import type { ClaudeCodeTools } from "./index";

export type ClaudeCodeMetadata = unknown;
export type ClaudeCodeDataTypes = Record<string, never>;
export type ClaudeCodeUIMessage = UIMessage<
  ClaudeCodeMetadata,
  ClaudeCodeDataTypes,
  ClaudeCodeTools
>;
```

```ts
// packages/ai-sdk-agents/src/codex/ui-message.ts
// Placeholder types until the codex adapter lands (design §1: codex is a first-class
// design target, implementation deferred). Keeps the envelope union total.
import type { UIMessage, UITools } from "ai";

export type CodexMetadata = unknown;
export type CodexDataTypes = Record<string, never>;
export type CodexTools = UITools;
export type CodexUIMessage = UIMessage<CodexMetadata, CodexDataTypes, CodexTools>;
```

```ts
// packages/ai-sdk-agents/src/types/envelope.ts
import type { InferUIMessageChunk } from "ai";
import type { ClaudeCodeUIMessage } from "../claude-code/ui-message";
import type { CodexUIMessage } from "../codex/ui-message";
import type { SessionEvent } from "../event-manifest";
import type { HarnessAgentId } from "./harness-agent-id";

export type ClaudeCodeUIMessageChunk = InferUIMessageChunk<ClaudeCodeUIMessage>;
export type CodexUIMessageChunk = InferUIMessageChunk<CodexUIMessage>;

/** A render chunk (hyphenated type) or a control event (dotted type). */
export type SessionEnvelopeBody = ClaudeCodeUIMessageChunk | CodexUIMessageChunk | SessionEvent;

// seq is stamped by the server EventBus (out of scope here); adapters emit drafts.
export type SessionEnvelope =
  | {
      harnessAgentId: "claude-code";
      sessionId: string;
      seq: number;
      body: ClaudeCodeUIMessageChunk | SessionEvent;
    }
  | {
      harnessAgentId: "codex";
      sessionId: string;
      seq: number;
      body: CodexUIMessageChunk | SessionEvent;
    };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SessionEnvelopeDraft = DistributiveOmit<SessionEnvelope, "seq">;

// The whole routing decision: event types always contain a dot, chunk types never do.
export const isSessionEvent = (body: SessionEnvelopeBody): body is SessionEvent =>
  body.type.includes(".");

export type { HarnessAgentId };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ai-sdk-agents test`
Expected: PASS (5 dotted → true, 11 hyphenated → false).

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-agents/src/claude-code/ui-message.ts packages/ai-sdk-agents/src/codex/ui-message.ts packages/ai-sdk-agents/src/types/envelope.ts packages/ai-sdk-agents/test/types/envelope.test.ts
git commit -m "feat(ai-sdk-agents): add UIMessage types, envelope, and isSessionEvent"
```

---

### Task 5: Session value types + lifecycle view (type-level)

**Files:**

- Create: `packages/ai-sdk-agents/src/types/session.ts`
- Test: `packages/ai-sdk-agents/test/types/session.test-d.ts`

**Interfaces:**

- Consumes: `SessionEnvelope` (Task 4); `AgentRequest` (Task 2); `HarnessAgentId` (Task 1).
- Produces: `SessionStatus`, `SessionSummary`, `SessionSnapshot`, `UserInput`, `CreateSessionConfig`, `AvailabilityResult`, `LifecycleView` (consumed by `toSessionEvent` in Task 7).

- [ ] **Step 1: Write the failing type test**

```ts
// packages/ai-sdk-agents/test/types/session.test-d.ts
import { expectTypeOf, test } from "vitest";
import type { CreateSessionConfig, LifecycleView, SessionSnapshot } from "../../src/types/session";

test("SessionSnapshot carries cold history + hot active turn + cursor", () => {
  expectTypeOf<SessionSnapshot>().toHaveProperty("history");
  expectTypeOf<SessionSnapshot>().toHaveProperty("activeTurn");
  expectTypeOf<SessionSnapshot["cursor"]>().toEqualTypeOf<number>();
});

test("LifecycleView exposes the active turn and a turn-id minter", () => {
  expectTypeOf<LifecycleView["activeTurnId"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf<LifecycleView["nextTurnId"]>().toEqualTypeOf<() => string>();
});

test("CreateSessionConfig requires a workspace path", () => {
  expectTypeOf<CreateSessionConfig["workspacePath"]>().toEqualTypeOf<string>();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ai-sdk-agents test`
Expected: FAIL — typecheck cannot resolve `../../src/types/session`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/ai-sdk-agents/src/types/session.ts
import type { UIMessage } from "ai";
import type { SessionEnvelope } from "./envelope";
import type { AgentRequest } from "./request";
import type { HarnessAgentId } from "./harness-agent-id";

export type SessionStatus = {
  status: "initializing" | "running" | "closed" | "crashed";
  isBusy: boolean;
  needsAttention: boolean;
};

export type SessionSummary = {
  sessionId: string;
  harnessAgentId: HarnessAgentId;
  title?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SessionSnapshot = {
  history: UIMessage[]; // cold: folded from the backend native store
  activeTurn: { chunks: SessionEnvelope[] } | null; // hot: active turn's render chunks
  pendingRequests: AgentRequest[];
  cursor: number; // last seq the client has seen for this session
  bootId: string;
};

export type UserInput = { text: string };
export type CreateSessionConfig = { workspacePath: string }; // model decided by the adapter
export type AvailabilityResult = { available: boolean; reason?: string };

/** Read-only view the adapter session hands to `toSessionEvent` for turn synthesis. */
export interface LifecycleView {
  readonly sessionId: string;
  readonly activeTurnId: string | undefined; // undefined = no turn in flight
  nextTurnId(): string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ai-sdk-agents test`
Expected: PASS (type tests compile).

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-agents/src/types/session.ts packages/ai-sdk-agents/test/types/session.test-d.ts
git commit -m "feat(ai-sdk-agents): add session value types and lifecycle view"
```

---

### Task 6: claude-code `transform` (SDKMessage → render chunks)

**Files:**

- Create: `packages/ai-sdk-agents/src/claude-code/transform.ts`
- Test: `packages/ai-sdk-agents/test/claude-code/transform.test.ts`

**Interfaces:**

- Consumes: `ClaudeCodeUIMessageChunk` (Task 4).
- Produces: `transform(message: SDKMessage): Generator<ClaudeCodeUIMessageChunk>` — the sync, per-message render mapping (the render half of the existing `to-ui-message.ts`, extracted so cold-fold and live-stream share it). `to-ui-message.ts` stays untouched this round.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ai-sdk-agents/test/claude-code/transform.test.ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { transform } from "../../src/claude-code/transform";

const collect = (m: SDKMessage) => [...transform(m)].map((c) => c.type);

describe("transform", () => {
  it("maps system.init to a start chunk", () => {
    expect(collect({ type: "system", subtype: "init" } as SDKMessage)).toEqual(["start"]);
  });

  it("maps an assistant text part to text start/delta/end", () => {
    const msg = {
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "m1", content: [{ type: "text", text: "hi" }] },
    } as unknown as SDKMessage;
    expect(collect(msg)).toEqual(["text-start", "text-delta", "text-end"]);
  });

  it("maps an assistant tool_use to tool-input-available", () => {
    const msg = {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m1",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    } as unknown as SDKMessage;
    const chunks = [...transform(msg)];
    expect(chunks[0]).toMatchObject({
      type: "tool-input-available",
      toolCallId: "t1",
      toolName: "Bash",
    });
  });

  it("maps result.success to a finish chunk", () => {
    expect(collect({ type: "result", subtype: "success" } as SDKMessage)).toEqual(["finish"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ai-sdk-agents test`
Expected: FAIL — cannot resolve `../../src/claude-code/transform`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/ai-sdk-agents/src/claude-code/transform.ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { generateId } from "ai";
import type { ClaudeCodeUIMessageChunk } from "../types/envelope";

/** Map ONE native claude-code message to zero or more render chunks. */
export function* transform(message: SDKMessage): Generator<ClaudeCodeUIMessageChunk> {
  switch (message.type) {
    case "system": {
      if (message.subtype === "init") yield { type: "start" };
      return;
    }
    case "assistant": {
      for (const part of message.message.content) {
        if (part.type === "text") {
          yield { type: "text-start", id: message.message.id };
          yield { type: "text-delta", id: message.message.id, delta: part.text };
          yield { type: "text-end", id: message.message.id };
        } else if (part.type === "tool_use") {
          yield {
            type: "tool-input-available",
            toolCallId: part.id,
            toolName: part.name,
            input: part.input,
            providerExecuted: true,
            providerMetadata: message.parent_tool_use_id
              ? { claudeCode: { parentToolUseId: message.parent_tool_use_id } }
              : undefined,
          };
        }
      }
      return;
    }
    case "user": {
      if (typeof message.message.content === "string") {
        const id = generateId();
        yield { type: "text-start", id };
        yield { type: "text-delta", id, delta: message.message.content };
        yield { type: "text-end", id };
        return;
      }
      for (const part of message.message.content) {
        if (part.type !== "tool_result") continue;
        const providerMetadata = message.parent_tool_use_id
          ? { claudeCode: { parentToolUseId: message.parent_tool_use_id } }
          : undefined;
        if (part.is_error) {
          yield {
            type: "tool-output-error",
            toolCallId: part.tool_use_id,
            errorText: typeof part.content === "string" ? part.content : "",
            providerExecuted: true,
            providerMetadata,
          };
        } else {
          yield {
            type: "tool-output-available",
            toolCallId: part.tool_use_id,
            output: part.content,
            providerExecuted: true,
            providerMetadata,
          };
        }
      }
      return;
    }
    case "result": {
      if (message.subtype === "success") yield { type: "finish" };
      return;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ai-sdk-agents test`
Expected: PASS (4 mapping cases).

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-agents/src/claude-code/transform.ts packages/ai-sdk-agents/test/claude-code/transform.test.ts
git commit -m "feat(ai-sdk-agents): add per-message claude-code transform"
```

---

### Task 7: claude-code `toSessionEvent` (SDKMessage → control event)

**Files:**

- Create: `packages/ai-sdk-agents/src/claude-code/to-session-event.ts`
- Test: `packages/ai-sdk-agents/test/claude-code/to-session-event.test.ts`

**Interfaces:**

- Consumes: `SessionEvent` (Task 3), `LifecycleView` (Task 5).
- Produces: `toSessionEvent(message: SDKMessage, view: LifecycleView): SessionEvent | undefined` — synthesizes `session.turn.started` on first activity of an idle session and `session.turn.ended` on a result; everything else is `undefined` (render content goes through `transform`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/ai-sdk-agents/test/claude-code/to-session-event.test.ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { toSessionEvent } from "../../src/claude-code/to-session-event";
import type { LifecycleView } from "../../src/types/session";

const idle: LifecycleView = {
  sessionId: "s1",
  activeTurnId: undefined,
  nextTurnId: () => "turn-1",
};
const active: LifecycleView = {
  sessionId: "s1",
  activeTurnId: "turn-1",
  nextTurnId: () => "turn-2",
};

describe("toSessionEvent", () => {
  it("starts a turn on first assistant activity of an idle session", () => {
    const ev = toSessionEvent(
      { type: "assistant", message: { id: "m", content: [] } } as unknown as SDKMessage,
      idle,
    );
    expect(ev).toMatchObject({ type: "session.turn.started", sessionId: "s1", turnId: "turn-1" });
  });

  it("does not restart a turn that is already active", () => {
    const ev = toSessionEvent(
      { type: "assistant", message: { id: "m", content: [] } } as unknown as SDKMessage,
      active,
    );
    expect(ev).toBeUndefined();
  });

  it("ends the active turn on a successful result", () => {
    const msg = {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 3, output_tokens: 7 },
    } as unknown as SDKMessage;
    expect(toSessionEvent(msg, active)).toMatchObject({
      type: "session.turn.ended",
      turnId: "turn-1",
      outcome: "completed",
      usage: { inputTokens: 3, outputTokens: 7 },
    });
  });

  it("marks a non-success result as failed", () => {
    const msg = { type: "result", subtype: "error_during_execution" } as unknown as SDKMessage;
    expect(toSessionEvent(msg, active)).toMatchObject({
      type: "session.turn.ended",
      outcome: "failed",
    });
  });

  it("returns undefined for a result when no turn is active", () => {
    const msg = { type: "result", subtype: "success" } as unknown as SDKMessage;
    expect(toSessionEvent(msg, idle)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ai-sdk-agents test`
Expected: FAIL — cannot resolve `../../src/claude-code/to-session-event`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/ai-sdk-agents/src/claude-code/to-session-event.ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionEvent } from "../event-manifest";
import type { LifecycleView } from "../types/session";

const ACTIVITY = new Set<SDKMessage["type"]>(["assistant", "user", "stream_event"]);

/** Fold a native message into a control event. Render content is handled by `transform`. */
export function toSessionEvent(message: SDKMessage, view: LifecycleView): SessionEvent | undefined {
  if (message.type === "result") {
    if (view.activeTurnId === undefined) return undefined;
    const usage = message.usage;
    return {
      type: "session.turn.ended",
      sessionId: view.sessionId,
      turnId: view.activeTurnId,
      outcome: message.subtype === "success" ? "completed" : "failed",
      usage: usage
        ? {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
            cacheCreationTokens: usage.cache_creation_input_tokens ?? undefined,
          }
        : undefined,
    };
  }

  if (view.activeTurnId === undefined && ACTIVITY.has(message.type)) {
    return { type: "session.turn.started", sessionId: view.sessionId, turnId: view.nextTurnId() };
  }

  return undefined;
}
```

> If the SDK's `result.usage` field names differ from the Anthropic `*_input_tokens` set assumed here, the failing `usage` assertion will surface it — adjust the field reads, not the shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ai-sdk-agents test`
Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-agents/src/claude-code/to-session-event.ts packages/ai-sdk-agents/test/claude-code/to-session-event.test.ts
git commit -m "feat(ai-sdk-agents): add claude-code toSessionEvent turn synthesis"
```

---

### Task 8: `foldToUIMessages` (cold read = folded transform output)

**Files:**

- Create: `packages/ai-sdk-agents/src/claude-code/fold.ts`
- Test: `packages/ai-sdk-agents/test/claude-code/fold.test.ts`

**Interfaces:**

- Consumes: `transform` (Task 6), `ClaudeCodeUIMessage` (Task 4), `ClaudeCodeUIMessageChunk` (Task 4).
- Produces: `foldToUIMessages(messages: Iterable<SDKMessage>): Promise<ClaudeCodeUIMessage[]>` — folds the same `transform` chunks through `readUIMessageStream`, so cold history equals the live stream's static form.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ai-sdk-agents/test/claude-code/fold.test.ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { foldToUIMessages } from "../../src/claude-code/fold";

describe("foldToUIMessages", () => {
  it("folds a single assistant turn into one UIMessage with a text part", async () => {
    const transcript = [
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "m1", content: [{ type: "text", text: "hello" }] },
      },
      { type: "result", subtype: "success" },
    ] as unknown as SDKMessage[];

    const messages = await foldToUIMessages(transcript);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.parts.some((p) => p.type === "text" && p.text === "hello")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ai-sdk-agents test`
Expected: FAIL — cannot resolve `../../src/claude-code/fold`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/ai-sdk-agents/src/claude-code/fold.ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { readUIMessageStream } from "ai";
import { transform } from "./transform";
import type { ClaudeCodeUIMessage } from "./ui-message";
import type { ClaudeCodeUIMessageChunk } from "../types/envelope";

/** Cold-fold a native transcript into UIMessage[] via the same render transform as the live stream. */
export async function foldToUIMessages(
  messages: Iterable<SDKMessage>,
): Promise<ClaudeCodeUIMessage[]> {
  const stream = new ReadableStream<ClaudeCodeUIMessageChunk>({
    start(controller) {
      for (const message of messages) {
        for (const chunk of transform(message)) controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  // readUIMessageStream yields the evolving message(s); keep the final snapshot per id.
  const byId = new Map<string, ClaudeCodeUIMessage>();
  for await (const msg of readUIMessageStream({ stream })) {
    byId.set(msg.id, msg as ClaudeCodeUIMessage);
  }
  return [...byId.values()];
}
```

> `readUIMessageStream` (ai ^5.0.63) consumes a `ReadableStream<UIMessageChunk>` and yields `UIMessage` snapshots. If it turns out to yield one accumulating message rather than per-id snapshots, the single-turn test still passes; extend the transcript in a follow-up test when the server slice needs multi-message cold reads.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ai-sdk-agents test`
Expected: PASS (one folded assistant message containing the text "hello").

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-agents/src/claude-code/fold.ts packages/ai-sdk-agents/test/claude-code/fold.test.ts
git commit -m "feat(ai-sdk-agents): add foldToUIMessages cold-read fold"
```

---

### Task 9: Barrel exports + full package gate

**Files:**

- Modify: `packages/ai-sdk-agents/src/index.ts`
- Modify: `packages/ai-sdk-agents/src/claude-code/index.ts:60-61` (append after the existing `Pushable`/`toUIMessage` exports)
- Test: `packages/ai-sdk-agents/test/exports.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–8.
- Produces: the package's public surface — `ai-sdk-agents` root re-exports the new `types/`, `events/`, `event-manifest`; `ai-sdk-agents/claude-code` additionally re-exports `transform`, `toSessionEvent`, `foldToUIMessages`, and the UIMessage types. Existing exports are untouched.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ai-sdk-agents/test/exports.test.ts
import { describe, expect, it } from "vitest";
import { defineEvent, isSessionEvent, SessionEventDefs } from "../src";
import { foldToUIMessages, toSessionEvent, transform } from "../src/claude-code";

describe("public exports", () => {
  it("re-exports the core abstraction from the package root", () => {
    expect(typeof defineEvent).toBe("function");
    expect(typeof isSessionEvent).toBe("function");
    expect(SessionEventDefs.length).toBeGreaterThan(0);
  });

  it("re-exports the claude-code transform/fold surface", () => {
    expect(typeof transform).toBe("function");
    expect(typeof toSessionEvent).toBe("function");
    expect(typeof foldToUIMessages).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ai-sdk-agents test`
Expected: FAIL — `defineEvent`/`transform` are not exported from the barrels yet.

- [ ] **Step 3: Write the implementation**

```ts
// packages/ai-sdk-agents/src/index.ts
// This package contains AI SDK integrations for various agents.
// Import from specific agent implementations:
// - ai-sdk-agents/claude-code

export * from "./types/harness-agent-id";
export * from "./types/event";
export * from "./types/request";
export * from "./types/envelope";
export * from "./types/session";
export * from "./events/session";
export * from "./event-manifest";
```

Append to `packages/ai-sdk-agents/src/claude-code/index.ts` (after the existing `export { toUIMessage } ...` line — do not remove any existing export):

```ts
export { transform } from "./transform";
export { toSessionEvent } from "./to-session-event";
export { foldToUIMessages } from "./fold";
export type { ClaudeCodeUIMessage, ClaudeCodeMetadata, ClaudeCodeDataTypes } from "./ui-message";
```

- [ ] **Step 4: Run the full package gate**

Run: `pnpm --filter ai-sdk-agents test`
Expected: PASS — all runtime + type tests green.

Run: `pnpm --filter ai-sdk-agents typecheck`
Expected: PASS — `tsc --noEmit` clean (no import cycle or missing-type errors across the new modules).

- [ ] **Step 5: Commit**

```bash
git add packages/ai-sdk-agents/src/index.ts packages/ai-sdk-agents/src/claude-code/index.ts packages/ai-sdk-agents/test/exports.test.ts
git commit -m "feat(ai-sdk-agents): export the two-plane ai-sdk abstraction"
```

---

## Out of Scope (follow-up plans)

- **Package rename** `ai-sdk-agents` → `ai-sdk-harness-agents` + migrating consumers (`ui`, `vibest`, `vibest-devtools-client`, `server-rpc`, `agents`) + removing the old `packages/agents`. Deferred because it touches `server-rpc` and other consumers.
- **`packages/server/src/agent/` Effect slice** (adapter / session / SessionLifecycle / EventBus seq+snapshot / registry / session-service) — its own plan; consumes this package.
- **Codex adapter** (app-server, codex transform/to-session-event, repository) — replaces the placeholder codex UIMessage types.
- **§7 micro-decisions** (verb-table extensions, versioning, `session.request.rejected` vs `replied` semantics) — resolve when the server slice needs them.

## Self-Review

- **Spec coverage:** §3.1 envelope + `isSessionEvent` → Task 4; §3.2 `defineEvent` + naming + catalog → Tasks 1/3; §3.3 AgentRequest/Response → Task 2; §3.4 value types + snapshot → Task 5; §3.5 transform + toSessionEvent → Tasks 6/7; §3.6 cold/hot fold → Task 8. Server-slice sections (§4) are explicitly out of scope. No spec gap within the package boundary.
- **Type consistency:** `HarnessAgentId`/`HarnessAgentIdSchema` (T1) → used T2/T3/T5; `SessionEvent` (T3) → T4/T7; `ClaudeCodeUIMessageChunk` (T4) → T6/T8; `LifecycleView` (T5) → T7; `transform` (T6) → T8. `foldToUIMessages`, `toSessionEvent`, `transform`, `isSessionEvent`, `defineEvent`, `SessionEventDefs` names are used identically across tasks and the export test.
- **Placeholder scan:** every code step is complete; the two `>` notes flag SDK-shape assumptions that TDD will confirm, not deferred work.
