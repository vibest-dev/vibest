import { Schema } from "effect"

export const KnowledgeCategorySchema = Schema.Literals(["artifacts", "docs", "memories", "preferences"])

export type KnowledgeCategory = typeof KnowledgeCategorySchema.Type

export const KnowledgeTabSchema = Schema.Literals(["artifacts", "docs", "memories"])

export type KnowledgeTab = typeof KnowledgeTabSchema.Type

export const StageModeSchema = Schema.Literals(["chat", "split", "stage"])

export type StageMode = typeof StageModeSchema.Type

export const SessionFilterSchema = Schema.Literals(["all", "needs_you", "working", "done"])

export type SessionFilter = typeof SessionFilterSchema.Type

export const ThemeModeSchema = Schema.Literals(["dark", "light"])

export type ThemeMode = typeof ThemeModeSchema.Type

export const HtmlModeSchema = Schema.Literals(["interact", "pick", "circle", "box"])

export type HtmlMode = typeof HtmlModeSchema.Type

export const GitBranchStateSchema = Schema.Struct({
  branch: Schema.String,
  pushed: Schema.Boolean,
  saved: Schema.Boolean,
  why: Schema.String,
})

export type GitBranchState = typeof GitBranchStateSchema.Type

export const SessionItemSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  agent: Schema.String,
  harness: Schema.String,
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  status: Schema.Literals(["idle", "working", "blocked", "done", "unknown"]),
  executionState: Schema.Literals(["none", "open", "completed", "failed", "interrupted", "lost", "not_started"]),
  projectId: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  runtime: Schema.String,
  machine: Schema.String,
  worktree: Schema.String,
  repositoryRoot: Schema.NullOr(Schema.String),
  git: Schema.NullOr(GitBranchStateSchema),
  createdAt: Schema.Number,
  lastActive: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  exitedAt: Schema.NullOr(Schema.Number),
  task: Schema.NullOr(Schema.String),
  summary: Schema.String,
  isEntry: Schema.Boolean,
  needsYou: Schema.Boolean,
})

export type SessionItem = typeof SessionItemSchema.Type

export const ProjectSummarySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  directory: Schema.String,
  entrySessionId: Schema.NullOr(Schema.String),
  activity: Schema.Literals(["blocked", "done", "working", "idle"]),
  machine: Schema.String,
  activeSubagents: Schema.Number,
  needsYouCount: Schema.Number,
  totalSessions: Schema.Number,
  branch: Schema.String,
})

export type ProjectSummary = typeof ProjectSummarySchema.Type

export const MachineLoadSnapshotSchema = Schema.Struct({
  sampledAt: Schema.Number,
  cpuCount: Schema.Number,
  cpuUtilization: Schema.NullOr(Schema.Number),
  memoryTotalBytes: Schema.Number,
  memoryAvailableBytes: Schema.Number,
  workingExecutions: Schema.Number,
})

export type MachineLoadSnapshot = typeof MachineLoadSnapshotSchema.Type

export const DaemonStatusSchema = Schema.Struct({
  connected: Schema.Boolean,
  mode: Schema.Literals(["live", "isolated"]),
  version: Schema.String,
  socket: Schema.String,
  load: Schema.NullOr(MachineLoadSnapshotSchema),
})

export type DaemonStatus = typeof DaemonStatusSchema.Type

export const ProjectFileEntrySchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  category: KnowledgeCategorySchema,
  name: Schema.String,
  relativePath: Schema.String,
  extension: Schema.String,
  size: Schema.Number,
  updatedAt: Schema.Number,
  kind: Schema.Literals(["markdown", "html", "excalidraw", "image", "video", "text"]),
})

export type ProjectFileEntry = typeof ProjectFileEntrySchema.Type

export const TimelineEntrySchema = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  projectId: Schema.String,
  role: Schema.Literals(["user", "assistant", "agent", "system"]),
  senderLabel: Schema.String,
  senderSessionId: Schema.NullOr(Schema.String),
  content: Schema.String,
  createdAt: Schema.Number,
  status: Schema.Literals(["completed", "working", "blocked", "failed", "queued"]),
  attachments: Schema.Array(Schema.String),
})

export type TimelineEntry = typeof TimelineEntrySchema.Type

export const PeekResultSchema = Schema.Struct({
  sessionId: Schema.String,
  text: Schema.String,
  terminal: Schema.String,
  updatedAt: Schema.Number,
})

export type PeekResult = typeof PeekResultSchema.Type

export const WorkspaceSnapshotSchema = Schema.Struct({
  daemon: DaemonStatusSchema,
  projects: Schema.Array(ProjectSummarySchema),
  sessions: Schema.Array(SessionItemSchema),
  filesByProject: Schema.Record(Schema.String, Schema.Array(ProjectFileEntrySchema)),
})

export type WorkspaceSnapshot = typeof WorkspaceSnapshotSchema.Type

export const StreamPayloadSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), data: WorkspaceSnapshotSchema }),
  Schema.Struct({ type: Schema.Literal("project"), data: ProjectSummarySchema }),
  Schema.Struct({ type: Schema.Literal("session"), data: SessionItemSchema }),
  Schema.Struct({
    type: Schema.Literal("session-ended"),
    data: Schema.Struct({ id: Schema.String, projectId: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("files-changed"),
    data: Schema.Struct({ projectId: Schema.String, files: Schema.Array(ProjectFileEntrySchema) }),
  }),
  Schema.Struct({ type: Schema.Literal("timeline-entry"), data: TimelineEntrySchema }),
  Schema.Struct({ type: Schema.Literal("daemon"), data: DaemonStatusSchema }),
])

export type StreamPayload = typeof StreamPayloadSchema.Type

export const StageItemSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("file"), file: ProjectFileEntrySchema }),
  Schema.Struct({ kind: Schema.Literal("terminal"), sessionId: Schema.String }),
])

export type StageItem = typeof StageItemSchema.Type

export const HoverTargetSchema = Schema.Struct({
  selector: Schema.String,
  tagName: Schema.String,
  textPreview: Schema.String,
  left: Schema.Number,
  top: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  xRatio: Schema.Number,
  yRatio: Schema.Number,
  wRatio: Schema.Number,
  hRatio: Schema.Number,
})

export type HoverTarget = typeof HoverTargetSchema.Type

export const PendingHtmlFeedbackSchema = Schema.Struct({
  kind: Schema.Literals(["element", "circle", "box"]),
  label: Schema.String,
  left: Schema.Number,
  top: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})

export type PendingHtmlFeedback = typeof PendingHtmlFeedbackSchema.Type

export const PointSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
})

export type Point = typeof PointSchema.Type

export const BoardNodeSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["rectangle", "ellipse", "diamond"]),
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  label: Schema.String,
  backgroundColor: Schema.String,
  strokeColor: Schema.String,
})

export type BoardNode = typeof BoardNodeSchema.Type

export const DemoProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  directory: Schema.String,
  entrySessionId: Schema.NullOr(Schema.String),
  activity: Schema.Literals(["blocked", "done", "working", "idle"]),
  machine: Schema.String,
  branch: Schema.String,
})

export const DemoStateSchema = Schema.Struct({
  version: Schema.String,
  load: MachineLoadSnapshotSchema,
  projects: Schema.Array(DemoProjectSchema),
  sessions: Schema.Array(SessionItemSchema),
  timelines: Schema.Array(TimelineEntrySchema),
  peeks: Schema.Record(Schema.String, Schema.String),
})

export interface ParsedAgentReport {
  readonly kind: "agent-report"
  readonly agentId: string
  readonly machine: string | null
  readonly firstLine: string
  readonly details: string
  readonly rawBody: string
}

export interface ParsedSystemNotice {
  readonly kind: "system-notice"
  readonly firstLine: string
  readonly body: string
}

export interface ParsedTextBlock {
  readonly kind: "text"
  readonly text: string
}

export type MessageBlock = ParsedTextBlock | ParsedAgentReport | ParsedSystemNotice

export const INITIAL_DAEMON: DaemonStatus = {
  connected: false,
  mode: "isolated",
  version: "0.0.2-dev",
  socket: "",
  load: null,
}

export class WebApiError extends Schema.TaggedError<WebApiError>()("WebApiError", {
  message: Schema.String,
}) {}
