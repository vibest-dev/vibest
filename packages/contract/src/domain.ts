import type { UIMessage, UIMessageChunk } from "ai";
import { Schema } from "effect";

export const toStandardSchema = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));

export const HarnessAgentIdSchema = Schema.Literals(["claude-code", "codex", "pi"]);
export type HarnessAgentId = typeof HarnessAgentIdSchema.Type;

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

export interface EventDef<
  T extends string = string,
  S extends Schema.Struct<Schema.Struct.Fields> = Schema.Struct<Schema.Struct.Fields>,
> {
  readonly type: T;
  readonly schema: S;
}

export type EventValue<D extends EventDef> =
  D extends EventDef<infer T, infer S> ? { readonly type: T } & S["Type"] : never;

export function defineEvent<const T extends string, const F extends Schema.Struct.Fields>(def: {
  readonly type: T;
  readonly schema: F;
}): EventDef<T, Schema.Struct<F>> {
  return { type: def.type, schema: Schema.Struct(def.schema) };
}

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

const sid = { sessionId: Schema.String };
export const SessionTurnStarted = defineEvent({
  type: "session.turn.started",
  schema: { ...sid, turnId: Schema.String },
});
export const SessionTurnEnded = defineEvent({
  type: "session.turn.ended",
  schema: {
    ...sid,
    turnId: Schema.String,
    outcome: Schema.Literals(["completed", "failed", "canceled"]),
    usage: Schema.optionalKey(TokenUsageSchema),
    error: Schema.optionalKey(TurnErrorSchema),
  },
});
export const SessionRequestAsked = defineEvent({
  type: "session.request.asked",
  schema: { ...sid, request: AgentRequestSchema },
});
export const SessionRequestReplied = defineEvent({
  type: "session.request.replied",
  schema: { ...sid, requestId: Schema.String },
});
export const SessionRequestRejected = defineEvent({
  type: "session.request.rejected",
  schema: { ...sid, requestId: Schema.String, reason: Schema.optionalKey(Schema.String) },
});
export const SessionCrashed = defineEvent({
  type: "session.crashed",
  schema: { ...sid, reason: Schema.String },
});
export const SessionCreated = defineEvent({
  type: "session.created",
  schema: { sessionId: Schema.String, harnessAgentId: HarnessAgentIdSchema },
});
export const SessionUpdated = defineEvent({
  type: "session.updated",
  schema: { sessionId: Schema.String },
});
export const SessionDeleted = defineEvent({
  type: "session.deleted",
  schema: { sessionId: Schema.String },
});
export const SessionRenamed = defineEvent({
  type: "session.renamed",
  schema: { sessionId: Schema.String, name: Schema.String },
});
export const ProjectUpdated = defineEvent({
  type: "project.updated",
  schema: { projectId: Schema.String },
});
export const PtyCreated = defineEvent({ type: "pty.created", schema: { ptyId: Schema.String } });
export const PtyUpdated = defineEvent({ type: "pty.updated", schema: { ptyId: Schema.String } });
export const PtyExited = defineEvent({
  type: "pty.exited",
  schema: { ptyId: Schema.String, exitCode: Schema.optionalKey(Schema.Number) },
});
export const ProviderUpdated = defineEvent({
  type: "provider.updated",
  schema: { providerId: Schema.String },
});
export const McpUpdated = defineEvent({
  type: "mcp.updated",
  schema: { serverId: Schema.String },
});
export const ServerConnected = defineEvent({ type: "server.connected", schema: {} });
export const ServerDisconnected = defineEvent({ type: "server.disconnected", schema: {} });

export const SessionEventDefs = [
  SessionTurnStarted,
  SessionTurnEnded,
  SessionRequestAsked,
  SessionRequestReplied,
  SessionRequestRejected,
  SessionCrashed,
] as const;
export type SessionEvent = EventValue<(typeof SessionEventDefs)[number]>;

export const GlobalEventDefs = [
  SessionCreated,
  SessionUpdated,
  SessionDeleted,
  SessionRenamed,
  ProjectUpdated,
  PtyCreated,
  PtyUpdated,
  PtyExited,
  ProviderUpdated,
  McpUpdated,
  ServerConnected,
  ServerDisconnected,
] as const;
export type GlobalEvent = EventValue<(typeof GlobalEventDefs)[number]>;

export type SessionEnvelopeBody = UIMessageChunk | SessionEvent;
export type SessionEnvelope = {
  readonly harnessAgentId: HarnessAgentId;
  readonly sessionId: string;
  readonly seq: number;
  readonly body: SessionEnvelopeBody;
};
export type SessionEnvelopeDraft = Omit<SessionEnvelope, "seq">;

export type SessionStatus = {
  status: "initializing" | "running" | "closed" | "crashed";
  isBusy: boolean;
  needsAttention: boolean;
};

export type SessionSnapshot = {
  history: UIMessage[];
  activeTurn: { turnId: string; chunks: SessionEnvelope[]; complete: boolean } | null;
  pendingRequests: AgentRequest[];
  cursor: number;
  degraded: boolean;
  bootId: string;
};

export const CreateSessionInputSchema = Schema.Struct({
  workspacePath: Schema.String,
  sessionId: Schema.optionalKey(Schema.String),
});
export type CreateSessionInput = typeof CreateSessionInputSchema.Type;

export const ResumeSessionInputSchema = Schema.Struct({
  sessionId: Schema.String,
  workspacePath: Schema.optionalKey(Schema.String),
});
export type ResumeSessionInput = typeof ResumeSessionInputSchema.Type;

export const InspectorTargetSchema = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
});
export type InspectorTarget = typeof InspectorTargetSchema.Type;

export const UserInputPartSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("data-inspector"),
    data: Schema.Array(InspectorTargetSchema),
  }),
]);
export type UserInputPart = typeof UserInputPartSchema.Type;

export const UserInputSchema = Schema.Struct({
  parts: Schema.Array(UserInputPartSchema),
  model: Schema.optionalKey(Schema.String),
});
export type UserInput = typeof UserInputSchema.Type;

export const PromptReceiptSchema = Schema.Struct({
  turnId: Schema.String,
  cursor: Schema.Number,
  started: Schema.Boolean,
});
export type PromptReceipt = typeof PromptReceiptSchema.Type;

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

export const CreateManagedSessionInputSchema = Schema.Struct({
  harnessAgentId: HarnessAgentIdSchema,
  workspacePath: Schema.optionalKey(Schema.String),
});
export type CreateManagedSessionInput = typeof CreateManagedSessionInputSchema.Type;

export const CreateManagedSessionResultSchema = Schema.Struct({
  sessionId: Schema.String,
  harnessAgentId: HarnessAgentIdSchema,
  // Backend session id (claude-code SDK session / codex threadId). Distinct from
  // the vibest-internal `sessionId`; used to resume the backend. Always present
  // on a freshly created session — the adapter opens the backend eagerly.
  harnessSessionId: Schema.String,
});
export type CreateManagedSessionResult = typeof CreateManagedSessionResultSchema.Type;

export const ResumeManagedSessionInputSchema = Schema.Struct({
  sessionId: Schema.String,
  harnessAgentId: HarnessAgentIdSchema,
  workspacePath: Schema.optionalKey(Schema.String),
  // The backend id to hand the adapter. Required — the caller resumes from a
  // listed session, which always carries it (a session with no backend id was
  // never opened and can only be created, not resumed).
  harnessSessionId: Schema.String,
});
export type ResumeManagedSessionInput = typeof ResumeManagedSessionInputSchema.Type;

/**
 * Persisted session metadata — vibest's own record, one file per session at
 * `storage/sessions/<projectId>/<sessionId>.json`. Holds only what the backend
 * harness cannot: the vibest-internal id, its mapping to the backend id, the
 * owning project, the workspace it was opened against, and vibest-owned state
 * (`archived`). Display data (title, timestamps) is fetched live from the
 * backend and merged at list time — never persisted here, to avoid drift.
 */
export const SessionRecordSchema = Schema.Struct({
  /** vibest-internal id (uuid v7) — the file name and primary key. */
  sessionId: Schema.String,
  /** Backend id used to resume; absent for a draft not yet opened. */
  harnessSessionId: Schema.optionalKey(Schema.String),
  harnessAgentId: HarnessAgentIdSchema,
  projectId: Schema.String,
  /** Workspace path the session was opened against (the backend's cwd key). */
  cwd: Schema.String,
  archived: Schema.Boolean,
  createdAt: Schema.String,
});
export type SessionRecord = typeof SessionRecordSchema.Type;

export const ListSessionsInputSchema = Schema.Struct({ projectId: Schema.String });
export type ListSessionsInput = typeof ListSessionsInputSchema.Type;

/**
 * A session list item: the persisted record plus display fields merged live
 * from the backend. `transcriptMissing` is derived (the backend no longer has
 * the transcript behind `harnessSessionId`) — never persisted. `title`/
 * `updatedAt` are absent until the adapter surfaces session info (phase 2).
 */
export const SessionSummarySchema = Schema.Struct({
  sessionId: Schema.String,
  harnessSessionId: Schema.optionalKey(Schema.String),
  harnessAgentId: HarnessAgentIdSchema,
  projectId: Schema.String,
  cwd: Schema.String,
  archived: Schema.Boolean,
  createdAt: Schema.String,
  title: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.Number),
  transcriptMissing: Schema.Boolean,
});
export type SessionSummary = typeof SessionSummarySchema.Type;

export const SessionIdInputSchema = Schema.Struct({ sessionId: Schema.String });
export const PromptSessionInputSchema = Schema.Struct({
  sessionId: Schema.String,
  input: UserInputSchema,
});
export const RespondToAgentRequestInputSchema = Schema.Struct({
  sessionId: Schema.String,
  requestId: Schema.String,
  response: AgentResponseSchema,
});
export const SessionEventsInputSchema = Schema.Struct({
  sessionId: Schema.String,
  after: Schema.optionalKey(Schema.Number),
});
