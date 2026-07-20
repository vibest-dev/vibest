import type { UIMessage, UIMessageChunk } from "ai";
import { Schema } from "effect";

export const toStandardSchema = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));

export const HarnessAgentIdSchema = Schema.Literals(["claude-code", "codex", "pi"]);
export type HarnessAgentId = typeof HarnessAgentIdSchema.Type;

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

export type SessionScopedEvent = { readonly seq: number } & SessionScopedEventDraft;

export type CollectionEvent = { readonly ref: SessionRef } & (
  | { readonly type: "session.created" }
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
};

// A permission preset the user can pick for a session. `id` is the harness's
// own outward vocabulary (mapped to its native system inside the adapter, e.g.
// Claude's `permissionMode` or Codex's approval + sandbox); `label` is the
// display string the UI renders verbatim.
export const HarnessAgentPermissionModeSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});
export type HarnessAgentPermissionMode = typeof HarnessAgentPermissionModeSchema.Type;

// Capabilities negotiated once per harness, not per session — identical for
// every session of a given harness (they depend on the agent's type + CLI/SDK
// version, not on any one session). Absent `permissionModes` means the harness
// has no permission protocol at all (e.g. Pi).
export const HarnessAgentCapabilitiesSchema = Schema.Struct({
  permissionModes: Schema.optionalKey(Schema.Array(HarnessAgentPermissionModeSchema)),
});
export type HarnessAgentCapabilities = typeof HarnessAgentCapabilitiesSchema.Type;

// One entry of the negotiation result: a harness the server hosts, whether it's
// usable right now (`available` + optional `reason`), and its capabilities. The
// UI reads `available` to decide which harnesses to offer and `capabilities` to
// drive per-harness controls (e.g. the permission-mode picker).
export const HarnessAgentInfoSchema = Schema.Struct({
  id: HarnessAgentIdSchema,
  name: Schema.String,
  available: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
  capabilities: HarnessAgentCapabilitiesSchema,
});
export type HarnessAgentInfo = typeof HarnessAgentInfoSchema.Type;

// The whole negotiation, exchanged once after the client connects (MCP
// `initialize`-style): the server declares every harness it hosts with its
// availability and capabilities in one shot. The client holds this and reads
// per-harness data by id — it never re-negotiates to switch the selected
// harness.
export const HarnessNegotiationSchema = Schema.Struct({
  harnessAgents: Schema.Array(HarnessAgentInfoSchema),
});
export type HarnessNegotiation = typeof HarnessNegotiationSchema.Type;

export type SessionRuntimeSnapshot = {
  readonly ref: SessionRef;
  readonly status: SessionStatus;
  readonly pendingRequests: ReadonlyArray<AgentRequest>;
  readonly activeTurn: ActiveTurnSnapshot | null;
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
  // Per-prompt model selection is a vibest addition not in the original design;
  // it stays until session-scoped setModel fully replaces it.
  model: Schema.optionalKey(Schema.String),
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
});
export const BrowseResultSchema = Schema.Struct({
  path: Schema.String,
  parent: Schema.Union([Schema.String, Schema.Null]),
  directories: Schema.Array(DirectoryEntrySchema),
});

// ---------------------------------------------------------------------------
// Lifecycle method inputs / outputs
// ---------------------------------------------------------------------------

// `model` / `permissionMode` are session-scoped config the user picks at create
// time and changes mid-session via the dedicated setModel / setPermissionMode
// calls — never carried on a prompt turn.
export const CreateSessionInputSchema = Schema.Struct({
  projectId: Schema.String.check(Schema.isUUID()),
  harnessAgentId: HarnessAgentIdSchema,
  model: Schema.optionalKey(Schema.String),
  // Outward permission-mode id from the session's harness capabilities.
  permissionMode: Schema.optionalKey(Schema.String),
});
export type CreateSessionInput = typeof CreateSessionInputSchema.Type;

export const ResumeSessionInputSchema = Schema.Struct({ ref: SessionRefSchema });
export type ResumeSessionInput = typeof ResumeSessionInputSchema.Type;

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

export type ListSessionsOutput = {
  readonly sessions: ReadonlyArray<SessionSummary>;
};

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

// Session-scoped config setters; `model` / `permissionMode` use the harness's
// outward vocabulary (see HarnessAgentCapabilities).
export const SetSessionModelInputSchema = Schema.Struct({
  ref: SessionRefSchema,
  model: Schema.String,
});
export type SetSessionModelInput = typeof SetSessionModelInputSchema.Type;

export const SetSessionPermissionModeInputSchema = Schema.Struct({
  ref: SessionRefSchema,
  permissionMode: Schema.String,
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
