import type { UIMessage, UIMessageChunk } from "ai";
import { Schema } from "effect";

export const toStandardSchema = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));

export const HarnessAgentIdSchema = Schema.Literals(["claude-code", "codex", "pi"]);
export type HarnessAgentId = typeof HarnessAgentIdSchema.Type;
// Derived from the schema rather than written out a second time: clients that
// need the ids as data (narrowing a URL param, say) would otherwise keep their
// own copy, and a fourth harness would silently miss it.
export const HARNESS_AGENT_IDS: ReadonlyArray<HarnessAgentId> = HarnessAgentIdSchema.literals;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const SessionRefSchema = Schema.Struct({
  projectId: Schema.String.check(Schema.isUUID()),
  harnessAgentId: HarnessAgentIdSchema,
  // Server-generated, opaque to clients; unique within a project.
  sessionId: Schema.NonEmptyString,
});
export type SessionRef = typeof SessionRefSchema.Type;

// ---------------------------------------------------------------------------
// Approval model (agent requests / responses)
// ---------------------------------------------------------------------------

export const AgentGrantSchema = Schema.Struct({ type: Schema.Literal("session") });
export type AgentGrant = typeof AgentGrantSchema.Type;

export const AgentRequestActionSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  behavior: Schema.Literals(["allow", "deny"]),
  grant: Schema.optionalKey(AgentGrantSchema),
  variant: Schema.optionalKey(Schema.Literals(["primary", "secondary", "danger"])),
});
export type AgentRequestAction = typeof AgentRequestActionSchema.Type;

export const AgentRequestQuestionSchema = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  header: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.Literals(["choice", "freeText"])),
  options: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        label: Schema.String,
        description: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  multiSelect: Schema.optionalKey(Schema.Boolean),
});
export type AgentRequestQuestion = typeof AgentRequestQuestionSchema.Type;

export const AgentRequestSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool"),
    id: Schema.String,
    harnessAgentId: HarnessAgentIdSchema,
    toolName: Schema.String,
    input: Schema.Record(Schema.String, Schema.Unknown),
    actions: Schema.Array(AgentRequestActionSchema),
    title: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    native: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("question"),
    id: Schema.String,
    harnessAgentId: HarnessAgentIdSchema,
    questions: Schema.Array(AgentRequestQuestionSchema),
    native: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("plan"),
    id: Schema.String,
    harnessAgentId: HarnessAgentIdSchema,
    plan: Schema.String,
    native: Schema.Unknown,
  }),
]);
export type AgentRequest = typeof AgentRequestSchema.Type;

export const AgentResponseAnswerSchema = Schema.Struct({
  questionId: Schema.String,
  values: Schema.Array(Schema.String),
  other: Schema.optionalKey(Schema.String),
});
export type AgentResponseAnswer = typeof AgentResponseAnswerSchema.Type;

export const PlanApprovalModeSchema = Schema.Literals([
  "default",
  "acceptEdits",
  "bypassPermissions",
]);
export type PlanApprovalMode = typeof PlanApprovalModeSchema.Type;

export const AgentResponseSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool"),
    selectedActionId: Schema.optionalKey(Schema.String),
    behavior: Schema.Literals(["allow", "deny"]),
    grant: Schema.optionalKey(AgentGrantSchema),
    message: Schema.optionalKey(Schema.String),
    interrupt: Schema.optionalKey(Schema.Boolean),
    native: Schema.optionalKey(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("question"),
    answers: Schema.Array(AgentResponseAnswerSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("plan"),
    behavior: Schema.Literals(["allow", "deny"]),
    mode: Schema.optionalKey(PlanApprovalModeSchema),
    message: Schema.optionalKey(Schema.String),
    interrupt: Schema.optionalKey(Schema.Boolean),
    native: Schema.optionalKey(Schema.Unknown),
  }),
]);
export type AgentResponse = typeof AgentResponseSchema.Type;

// ---------------------------------------------------------------------------
// Turn outcome
// ---------------------------------------------------------------------------

export const TokenUsageSchema = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.optionalKey(Schema.Number),
  cacheCreationTokens: Schema.optionalKey(Schema.Number),
});
export type TokenUsage = typeof TokenUsageSchema.Type;

export const TurnErrorCategorySchema = Schema.Literals([
  "auth_expired",
  "rate_limited",
  "context_overflow",
  "model_unavailable",
  "network",
  "cancelled",
  "unknown",
]);
export type TurnErrorCategory = typeof TurnErrorCategorySchema.Type;

export const TurnErrorSchema = Schema.Struct({
  message: Schema.String,
  category: TurnErrorCategorySchema,
  retryAfterMs: Schema.optionalKey(Schema.Number),
});
export type TurnError = typeof TurnErrorSchema.Type;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const SessionPhaseSchema = Schema.Literals([
  "idle",
  "running",
  "requires_action",
  "crashed",
]);
export type SessionPhase = typeof SessionPhaseSchema.Type;

export const SessionStatusSchema = Schema.Struct({
  phase: SessionPhaseSchema,
  activeTurnId: Schema.optionalKey(Schema.String),
});
export type SessionStatus = typeof SessionStatusSchema.Type;

// ---------------------------------------------------------------------------
// Events
//
// Session-scoped events carry `seq`: contiguous per session, stamped by the
// SessionRuntime, starting at 1. Collection events are unnumbered — they are
// invalidation signals recovered via list methods, never replayed. Events are
// TypeScript types, not Schemas: they are produced by the server and never
// validated as RPC input.
// ---------------------------------------------------------------------------

export const SessionScopedEventTypes = [
  "session.message.chunk",
  "session.prompt.submitted",
  "session.prompt.rejected",
  "session.turn.started",
  "session.turn.ended",
  "session.request.asked",
  "session.request.replied",
  "session.request.rejected",
  "session.crashed",
] as const;
export type SessionScopedEventType = (typeof SessionScopedEventTypes)[number];

export const CollectionEventTypes = [
  "session.created",
  "session.updated",
  "session.deleted",
  "session.renamed",
] as const;
export type CollectionEventType = (typeof CollectionEventTypes)[number];

export type SessionScopedEventBody =
  | {
      readonly type: "session.message.chunk";
      readonly turnId: string;
      readonly chunk: UIMessageChunk;
    }
  // A user prompt was accepted for this session. Published by the session
  // service *before* the harness call, so it always precedes the turn's own
  // events in seq order; `messageId` echoes the client-supplied id (or a
  // server-minted one), letting the prompting client dedupe its optimistic
  // message while every other client appends it. If the harness then rejects
  // the prompt, `session.prompt.rejected` compensates.
  | {
      readonly type: "session.prompt.submitted";
      readonly messageId: string;
      readonly parts: ReadonlyArray<PromptPart>;
    }
  // Compensates a `session.prompt.submitted` whose harness call was then
  // rejected (turn already running, session closed, harness error): clients
  // drop the message with this id, and the runtime clears the retained
  // activePrompt so a mid-turn joiner never hydrates a prompt that never ran.
  | {
      readonly type: "session.prompt.rejected";
      readonly messageId: string;
      readonly reason?: string;
    }
  | { readonly type: "session.turn.started"; readonly turnId: string }
  | {
      readonly type: "session.turn.ended";
      readonly turnId: string;
      readonly outcome: "completed" | "failed" | "canceled";
      readonly usage?: TokenUsage;
      readonly error?: TurnError;
    }
  | { readonly type: "session.request.asked"; readonly request: AgentRequest }
  | { readonly type: "session.request.replied"; readonly requestId: string }
  | {
      readonly type: "session.request.rejected";
      readonly requestId: string;
      readonly reason?: string;
    }
  | { readonly type: "session.crashed"; readonly reason: string };

/** A session-scoped event before the SessionRuntime stamps its `seq`. */
export type SessionScopedEventDraft = { readonly ref: SessionRef } & SessionScopedEventBody;

export type SessionScopedEvent = {
  readonly seq: number;
  /**
   * The session's phase *after* this event applied, stamped by the
   * SessionRuntime alongside `seq`. Consumers copy it (sidebar status, chat
   * composer state) instead of re-deriving phase from event types — the
   * runtime is the only place that knows the full transition table
   * (`requires_action` in particular is invisible to a client-side mapping).
   * Absent only on chunk events replayed from a snapshot's retained buffer;
   * there the snapshot's own `status` is the phase source.
   */
  readonly phase?: SessionPhase;
} & SessionScopedEventDraft;

export type CollectionEvent = { readonly ref: SessionRef } & (
  | { readonly type: "session.created" }
  // Self-owned display data changed on the server (currently the title, stamped
  // from the first prompt). Carries the new value so clients patch the row in
  // place instead of clobbering an optimistic title with a refetch.
  | { readonly type: "session.updated"; readonly title?: string }
  | { readonly type: "session.deleted" }
  | { readonly type: "session.renamed"; readonly name: string }
);

export type ServerEvent = SessionScopedEvent | CollectionEvent;

export type SessionMessageChunkEvent = Extract<
  SessionScopedEvent,
  { type: "session.message.chunk" }
>;

const collectionEventTypes = new Set<string>(CollectionEventTypes);

export const isSessionScopedEvent = (event: ServerEvent): event is SessionScopedEvent =>
  !collectionEventTypes.has(event.type);

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

export const SubscriptionScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("session"), ref: SessionRefSchema }),
  // Firehose: every event of every session plus collection events.
  Schema.Struct({ kind: Schema.Literal("global") }),
]);
export type SubscriptionScope = typeof SubscriptionScopeSchema.Type;

export const SubscribeInputSchema = Schema.Struct({ scope: SubscriptionScopeSchema });
export type SubscribeInput = typeof SubscribeInputSchema.Type;

export const SubscriptionClosedReasonSchema = Schema.Literals([
  "session_closed",
  "session_deleted",
  "stream_replaced",
  "slow_consumer",
  "server_shutdown",
  "internal_error",
]);
export type SubscriptionClosedReason = typeof SubscriptionClosedReasonSchema.Type;

export type SubscribeStreamEvent =
  | { readonly type: "event"; readonly event: ServerEvent }
  | { readonly type: "closed"; readonly reason: SubscriptionClosedReason };

/**
 * Client-side reducer position; never sent on the wire. Only meaningful while
 * the renderer still holds the reducer state merged up to `lastAppliedSeq` of
 * `turnId` — recovery re-reads `getSnapshot` and replays `activeTurn.chunks`
 * with `seq > lastAppliedSeq`.
 */
export type StreamingCursor = {
  readonly turnId: string;
  readonly lastAppliedSeq: number;
};

// ---------------------------------------------------------------------------
// Runtime snapshot
// ---------------------------------------------------------------------------

export type ActiveTurnSnapshot = {
  readonly turnId: string;
  // null until the turn's first `start` chunk announces the message id.
  readonly messageId: string | null;
  readonly chunks: ReadonlyArray<SessionMessageChunkEvent>;
  // A finished turn's buffer is retained (complete: true) until the next turn
  // starts, so recovery can replay a tail that ended mid-disconnect.
  readonly complete: boolean;
  // The buffer is bounded; a turn that overflowed it had its oldest chunks
  // dropped. A truncated buffer cannot rebuild the turn's message from its
  // start — consumers skip it and recover the turn from the history read
  // once it ends.
  readonly truncated: boolean;
};

// The latest accepted prompt, retained like the active turn's buffer:
// `session.prompt.submitted` is never re-sent, so a client attaching mid-turn
// recovers the user message from here. `seq` is the submit event's seq — replay
// gates on it, so a client that saw the live event never renders it twice.
export type ActivePromptSnapshot = {
  readonly messageId: string;
  readonly parts: ReadonlyArray<PromptPart>;
  readonly seq: number;
};

// ---------------------------------------------------------------------------
// Session settings (docs/design/harness-concept-ownership.md)
//
// Two channels, split by who owns the value's meaning:
// - Normalized: vibest defines a closed union, adapters declare the subset they
//   support and map members to their native system privately. Labels, icons and
//   ordering live in the client — the words are ours.
// - Opaque: the harness/provider defines an open set we merely relay. Labels
//   must come from the source (only it knows the value), ids are atomic (never
//   parsed or compared substring-wise outside the owning adapter).
// ---------------------------------------------------------------------------

// Our permission vocabulary — the union of what we promise across harnesses,
// not any single harness's list. `plan` and `read-only` coexist on purpose:
// mapping codex's read-only sandbox onto `plan` would lie (codex produces no
// plan and never triggers the plan-approval flow).
export const PermissionModeSchema = Schema.Literals([
  "plan",
  "read-only",
  "ask",
  "acceptEdits",
  "full",
]);
export type PermissionMode = typeof PermissionModeSchema.Type;

// Normalized companion traits of a model (see ModelInfoSchema): the id is
// opaque, but capabilities we must branch on are translated into our closed
// sets by the adapter. Values the adapter doesn't recognise are dropped, so a
// newer harness degrades to "one less control", never to a wrong render.
export const ReasoningEffortSchema = Schema.Literals([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = typeof ReasoningEffortSchema.Type;

export const InputModalitySchema = Schema.Literals(["text", "image"]);
export type InputModality = typeof InputModalitySchema.Type;

// A model as its provider reports it: opaque `id`/`label` (we don't know what
// `sonnet` means — only its provider does), plus normalized traits. A missing
// `reasoningEfforts` means this model has no reasoningEffort switch the session can drive; the
// client renders no control. `modalities` absent means "assume text only".
export const ModelInfoSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.optionalKey(Schema.String),
  reasoningEfforts: Schema.optionalKey(Schema.Array(ReasoningEffortSchema)),
  defaultReasoningEffort: Schema.optionalKey(ReasoningEffortSchema),
  modalities: Schema.optionalKey(Schema.Array(InputModalitySchema)),
});
export type ModelInfo = typeof ModelInfoSchema.Type;

// A source of models. Today every harness doubles as exactly one built-in
// provider (`id === harnessAgentId`); user-configured providers join the same
// shape later. Models never leave their provider — flattening loses the half
// of the composite key that makes `modelId` meaningful.
// No default marker on purpose: a catalog's "default" flag is the provider's
// suggestion, not what an unconfigured session actually runs (the harness's
// own user config decides that, and it is not probeable). The default is
// expressed by absence — no pick on the wire means the harness decides.
export const ProviderInfoSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.optionalKey(Schema.String),
  models: Schema.Array(ModelInfoSchema),
});
export type ProviderInfo = typeof ProviderInfoSchema.Type;

// A model is addressed by the flat pair `providerId` + `modelId`, always
// travelling together: `modelId` is only unique within its provider, so one
// without the other is meaningless. `providerId` is a routing key like a
// sessionId — the client groups and echoes it but never branches on its value.

// One entry of `harness.list`: a harness the server hosts, whether it's usable
// right now (`available` + optional `reason`), and the normalized settings it
// declares. `permissionModes` is the subset of our vocabulary this harness can
// honour — empty means it has no permission protocol at all (pi) and the UI
// renders no control. `defaultPermissionMode` differs per harness on purpose:
// codex's "full" also drops its sandbox, so it defaults lower than claude-code.
export const HarnessAgentInfoSchema = Schema.Struct({
  id: HarnessAgentIdSchema,
  name: Schema.String,
  available: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
  permissionModes: Schema.Array(PermissionModeSchema),
  defaultPermissionMode: Schema.optionalKey(PermissionModeSchema),
});
export type HarnessAgentInfo = typeof HarnessAgentInfoSchema.Type;

export const HarnessListOutputSchema = Schema.Struct({
  harnessAgents: Schema.Array(HarnessAgentInfoSchema),
});
export type HarnessListOutput = typeof HarnessListOutputSchema.Type;

// Addressed by directory, not by projectId: the harness layer has never known
// what a project is (see `session/port.ts` — "the port speaks ... a resolved
// `cwd` only"), and the directory is what the answer actually depends on. It
// also makes the cache key right for free: two projects registered at the same
// path share one probe instead of spawning twice for the same answer.
export const HarnessProbeInputSchema = Schema.Struct({
  harnessAgentId: HarnessAgentIdSchema,
  cwd: Schema.String,
});
export type HarnessProbeInput = typeof HarnessProbeInputSchema.Type;

// What probing one harness in one directory yielded. Empty `providers` means
// the harness has no model catalogue at all (pi). A failed probe is an error,
// never an empty result — an expired login must stay distinguishable from
// "this harness has no model picker".
export const HarnessProbeOutputSchema = Schema.Struct({
  providers: Schema.Array(ProviderInfoSchema),
});
export type HarnessProbeOutput = typeof HarnessProbeOutputSchema.Type;

export type SessionRuntimeSnapshot = {
  readonly ref: SessionRef;
  readonly status: SessionStatus;
  readonly pendingRequests: ReadonlyArray<AgentRequest>;
  readonly activeTurn: ActiveTurnSnapshot | null;
  readonly activePrompt: ActivePromptSnapshot | null;
  // Last session-scoped seq folded into this snapshot; 0 before any event.
  readonly cursor: number;
};

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type SessionMessages = {
  readonly messages: ReadonlyArray<UIMessage>;
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const InspectorTargetSchema = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
});
export type InspectorTarget = typeof InspectorTargetSchema.Type;

export const PromptPartSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.NonEmptyString }),
  // Reserved wire shape: servers reject file parts with UNSUPPORTED until an
  // agent capability lands. Never silently dropped.
  Schema.Struct({
    type: Schema.Literal("file"),
    mediaType: Schema.String,
    url: Schema.String,
    filename: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("data-inspector"),
    data: Schema.Array(InspectorTargetSchema),
  }),
]);
export type PromptPart = typeof PromptPartSchema.Type;

export const PromptInputSchema = Schema.Struct({
  ref: SessionRefSchema,
  parts: Schema.Array(PromptPartSchema).check(Schema.isNonEmpty()),
  // The client's own id for the optimistic user message, echoed back in
  // `session.prompt.submitted` so the sender can recognise (and skip) its own
  // prompt while other clients render it. Absent → the server mints one.
  messageId: Schema.optionalKey(Schema.NonEmptyString),
});
export type PromptInput = typeof PromptInputSchema.Type;

export const PromptOutputSchema = Schema.Struct({ turnId: Schema.String });
export type PromptOutput = typeof PromptOutputSchema.Type;

// ---------------------------------------------------------------------------
// Session capabilities (unchanged; setModel/config remains out of scope)
// ---------------------------------------------------------------------------

export const SessionCapabilitiesSchema = Schema.Struct({
  models: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) })),
  ),
  commands: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ name: Schema.String, description: Schema.optionalKey(Schema.String) }),
    ),
  ),
  mcpServers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String })),
  ),
  supportsResume: Schema.Boolean,
  supportsSteering: Schema.Boolean,
  supportsPermissions: Schema.Boolean,
});
export type SessionCapabilities = typeof SessionCapabilitiesSchema.Type;

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const ProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
  createdAt: Schema.String,
});
export type Project = typeof ProjectSchema.Type;

/** The project name is derived server-side from the folder's basename. */
export const CreateProjectInputSchema = Schema.Struct({
  path: Schema.String,
});

export const DirectoryEntrySchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
});
export type DirectoryEntry = typeof DirectoryEntrySchema.Type;

export const BrowseInputSchema = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  includeHidden: Schema.optionalKey(Schema.Boolean),
});
export const BrowseResultSchema = Schema.Struct({
  path: Schema.String,
  parent: Schema.Union([Schema.String, Schema.Null]),
  directories: Schema.Array(DirectoryEntrySchema),
});

// ---------------------------------------------------------------------------
// Lifecycle method inputs / outputs
// ---------------------------------------------------------------------------

// Session-scoped config the user picks at create time and changes mid-session
// via the dedicated setters — never carried on a prompt turn. The two channels
// fail differently on purpose: `permissionMode` is our closed union (a bad
// value is a client bug → INVALID_ARGUMENT), while the model pair and `reasoningEffort`
// come from probed lists that go stale, so applying them is best-effort — a
// miss falls back to the harness default and the session still opens.
// `providerId`/`modelId` must be given together; a half pair is a client bug
// the RPC boundary rejects.
export const CreateSessionInputSchema = Schema.Struct({
  projectId: Schema.String.check(Schema.isUUID()),
  harnessAgentId: HarnessAgentIdSchema,
  providerId: Schema.optionalKey(Schema.String),
  modelId: Schema.optionalKey(Schema.String),
  reasoningEffort: Schema.optionalKey(ReasoningEffortSchema),
  permissionMode: Schema.optionalKey(PermissionModeSchema),
});
export type CreateSessionInput = typeof CreateSessionInputSchema.Type;

export const ListSessionsInputSchema = Schema.Struct({
  projectId: Schema.String.check(Schema.isUUID()),
});
export type ListSessionsInput = typeof ListSessionsInputSchema.Type;

export type SessionSummary = {
  readonly projectId: string;
  readonly harnessAgentId: HarnessAgentId;
  readonly sessionId: string;
  readonly title?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly historyAvailable: boolean;
  readonly status?: SessionStatus;
};

/** `session.list` returns the summaries directly — one shape, no wrapper. */
export type ListSessionsOutput = ReadonlyArray<SessionSummary>;

export const RenameSessionInputSchema = Schema.Struct({
  ref: SessionRefSchema,
  name: Schema.NonEmptyString,
});
export type RenameSessionInput = typeof RenameSessionInputSchema.Type;

export const RefInputSchema = Schema.Struct({ ref: SessionRefSchema });
export type RefInput = typeof RefInputSchema.Type;

// The server sessionId is a globally-unique uuid, so projectId + harnessAgentId
// are recoverable from it alone. Clients that only hold a sessionId (a
// bookmarked/reloaded URL) resolve the full SessionRef through this.
export const ResolveRefInputSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isUUID()),
});
export type ResolveRefInput = typeof ResolveRefInputSchema.Type;

// Session-scoped config setters. `setModel` resets the reasoningEffort to the new
// model's default (the reasoningEffort domain cascades from the selected model), so a
// client that wants a non-default reasoningEffort calls `setReasoningEffort` after.
export const SetSessionModelInputSchema = Schema.Struct({
  ref: SessionRefSchema,
  providerId: Schema.String,
  modelId: Schema.String,
});
export type SetSessionModelInput = typeof SetSessionModelInputSchema.Type;

export const SetSessionReasoningEffortInputSchema = Schema.Struct({
  ref: SessionRefSchema,
  reasoningEffort: ReasoningEffortSchema,
});
export type SetSessionReasoningEffortInput = typeof SetSessionReasoningEffortInputSchema.Type;

export const SetSessionPermissionModeInputSchema = Schema.Struct({
  ref: SessionRefSchema,
  permissionMode: PermissionModeSchema,
});
export type SetSessionPermissionModeInput = typeof SetSessionPermissionModeInputSchema.Type;

export const RespondToAgentRequestInputSchema = Schema.Struct({
  ref: SessionRefSchema,
  requestId: Schema.String,
  response: AgentResponseSchema,
});
export type RespondToAgentRequestInput = typeof RespondToAgentRequestInputSchema.Type;

// ---------------------------------------------------------------------------
// Errors
//
// Shared oRPC error map. New-contract procedures attach it with
// `oc.errors(serverErrors)`; clients branch on the error code, never on the
// message.
// ---------------------------------------------------------------------------

export const ServerErrorCodes = [
  "INVALID_ARGUMENT",
  "FORBIDDEN",
  "NOT_FOUND",
  "SESSION_NOT_ACTIVE",
  "SESSION_CRASHED",
  "CONFLICT",
  "UNSUPPORTED",
  "INTERNAL",
] as const;
export type ServerErrorCode = (typeof ServerErrorCodes)[number];

export const serverErrors = {
  INVALID_ARGUMENT: {},
  FORBIDDEN: {},
  NOT_FOUND: {},
  SESSION_NOT_ACTIVE: {},
  SESSION_CRASHED: {},
  CONFLICT: {},
  UNSUPPORTED: {},
  INTERNAL: {},
} as const;
