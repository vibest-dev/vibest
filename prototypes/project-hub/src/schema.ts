import { z } from "zod"

export const TaskStatusSchema = z.enum(["active", "done", "cancelled"])

export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const ArtifactKindSchema = z.enum(["markdown", "html", "whiteboard", "verify"])

export type ArtifactKind = z.infer<typeof ArtifactKindSchema>

export const ReviewStatusSchema = z.enum(["none", "requested", "approved", "changes_requested"])

export type ReviewStatus = z.infer<typeof ReviewStatusSchema>

export const ReviewVerdictSchema = z.enum(["approved", "changes_requested", "commented"])

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>

export const SessionStatusSchema = z.enum(["running", "idle", "blocked", "ended"])

export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const DecisionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
})

export type DecisionOption = z.infer<typeof DecisionOptionSchema>

export const DecisionQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  context: z.string().optional(),
  multiSelect: z.boolean().default(false),
  options: z.array(DecisionOptionSchema),
})

export type DecisionQuestion = z.infer<typeof DecisionQuestionSchema>

export const HtmlVariantSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  fileName: z.string(),
})

export type HtmlVariant = z.infer<typeof HtmlVariantSchema>

export const VerifyGateSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  status: z.enum(["passed", "failed", "pending"]),
  durationMs: z.number().optional(),
  detail: z.string().optional(),
})

export type VerifyGate = z.infer<typeof VerifyGateSchema>

export const VerifyCardDataSchema = z.object({
  goal: z.string(),
  branch: z.string(),
  commitSha: z.string(),
  prUrl: z.string().optional(),
  gates: z.array(VerifyGateSchema),
  risks: z.array(z.string()),
  unverified: z.array(z.string()),
  authorizedCommand: z.string().optional(),
})

export type VerifyCardData = z.infer<typeof VerifyCardDataSchema>

export const ArtifactMetadataSchema = z.object({
  variants: z.array(HtmlVariantSchema).optional(),
  selectedVariantId: z.string().optional(),
  verifyCard: VerifyCardDataSchema.optional(),
  fileOrigin: z.string().optional(),
})

export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>

export const DomAnchorSchema = z.object({
  kind: z.literal("dom"),
  variantId: z.string(),
  selector: z.string(),
  tagName: z.string(),
  textPreview: z.string(),
  xRatio: z.number(),
  yRatio: z.number(),
  wRatio: z.number(),
  hRatio: z.number(),
})

export type DomAnchor = z.infer<typeof DomAnchorSchema>

export const RegionAnchorSchema = z.object({
  kind: z.literal("region"),
  variantId: z.string(),
  regionStyle: z.enum(["box", "circle"]),
  label: z.string().optional(),
  xRatio: z.number(),
  yRatio: z.number(),
  wRatio: z.number(),
  hRatio: z.number(),
})

export type RegionAnchor = z.infer<typeof RegionAnchorSchema>

export const WhiteboardAnchorSchema = z.object({
  kind: z.literal("whiteboard"),
  elementIds: z.array(z.string()),
  elementLabels: z.array(z.string()),
  x: z.number().optional(),
  y: z.number().optional(),
})

export type WhiteboardAnchor = z.infer<typeof WhiteboardAnchorSchema>

export const QuoteAnchorSchema = z.object({
  kind: z.literal("quote"),
  quote: z.string(),
  blockHeading: z.string().optional(),
  lineHint: z.number().optional(),
})

export type QuoteAnchor = z.infer<typeof QuoteAnchorSchema>

export const VerifyAnchorSchema = z.object({
  kind: z.literal("verify"),
  section: z.string(),
  gateId: z.string().optional(),
})

export type VerifyAnchor = z.infer<typeof VerifyAnchorSchema>

export const CommentAnchorSchema = z.discriminatedUnion("kind", [
  DomAnchorSchema,
  RegionAnchorSchema,
  WhiteboardAnchorSchema,
  QuoteAnchorSchema,
  VerifyAnchorSchema,
])

export type CommentAnchor = z.infer<typeof CommentAnchorSchema>

export const CommentReplySchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  createdAt: z.number(),
})

export type CommentReply = z.infer<typeof CommentReplySchema>

export const CommentThreadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  artifactId: z.string(),
  artifactVersion: z.number(),
  pinNumber: z.number(),
  author: z.string(),
  body: z.string(),
  anchor: CommentAnchorSchema,
  resolved: z.boolean(),
  replies: z.array(CommentReplySchema),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type CommentThread = z.infer<typeof CommentThreadSchema>

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  repoPath: z.string().optional(),
  vibestProjectDir: z.string().optional(),
  entrySessionId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type Project = z.infer<typeof ProjectSchema>

export const TaskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: TaskStatusSchema,
  summary: z.string(),
  branch: z.string().optional(),
  prUrl: z.string().optional(),
  sessionIds: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type Task = z.infer<typeof TaskSchema>

export const SessionRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string().optional(),
  parentSessionId: z.string().optional(),
  name: z.string(),
  agent: z.string(),
  harness: z.string(),
  model: z.string().optional(),
  directory: z.string(),
  status: SessionStatusSchema,
  blockedReason: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type SessionRecord = z.infer<typeof SessionRecordSchema>

export const ArtifactVersionRecordSchema = z.object({
  version: z.number(),
  summary: z.string(),
  contentPath: z.string(),
  createdAt: z.number(),
})

export type ArtifactVersionRecord = z.infer<typeof ArtifactVersionRecordSchema>

export const ArtifactSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string().optional(),
  slug: z.string(),
  title: z.string(),
  kind: ArtifactKindSchema,
  summary: z.string(),
  version: z.number(),
  reviewStatus: ReviewStatusSchema,
  contentPath: z.string(),
  questions: z.array(DecisionQuestionSchema),
  answers: z.record(z.string(), z.array(z.string())),
  metadata: ArtifactMetadataSchema,
  authorSessionId: z.string().optional(),
  lastReviewPayload: z.string().optional(),
  versions: z.array(ArtifactVersionRecordSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type Artifact = z.infer<typeof ArtifactSchema>

export const NeedsYouItemSchema = z.discriminatedUnion("itemType", [
  z.object({
    itemType: z.literal("artifact_review"),
    id: z.string(),
    projectId: z.string(),
    taskId: z.string().optional(),
    taskTitle: z.string().optional(),
    artifact: ArtifactSchema,
    openCommentCount: z.number(),
    unansweredQuestionCount: z.number(),
    updatedAt: z.number(),
  }),
  z.object({
    itemType: z.literal("blocked_session"),
    id: z.string(),
    projectId: z.string(),
    taskId: z.string().optional(),
    taskTitle: z.string().optional(),
    session: SessionRecordSchema,
    updatedAt: z.number(),
  }),
])

export type NeedsYouItem = z.infer<typeof NeedsYouItemSchema>

export const TaskLaneCardSchema = z.object({
  task: TaskSchema,
  sessions: z.array(SessionRecordSchema),
  artifacts: z.array(ArtifactSchema),
})

export type TaskLaneCard = z.infer<typeof TaskLaneCardSchema>

export const BoardViewDataSchema = z.object({
  project: ProjectSchema,
  needsYou: z.array(NeedsYouItemSchema),
  inProgress: z.array(TaskLaneCardSchema),
  doneTasks: z.array(TaskLaneCardSchema),
  doneStandaloneArtifacts: z.array(ArtifactSchema),
  sessionFactsMarkdown: z.string(),
})

export type BoardViewData = z.infer<typeof BoardViewDataSchema>

export const KnowledgeFileEntrySchema = z.object({
  relativePath: z.string(),
  category: z.enum(["preferences", "memories", "docs"]),
  sizeBytes: z.number(),
  updatedAt: z.number(),
})

export type KnowledgeFileEntry = z.infer<typeof KnowledgeFileEntrySchema>

export const HubEventFactSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("project.created"),
    project: ProjectSchema,
  }),
  z.object({
    type: z.literal("project.updated"),
    projectId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    entrySessionId: z.string().optional(),
    updatedAt: z.number(),
  }),
  z.object({
    type: z.literal("task.created"),
    task: TaskSchema,
  }),
  z.object({
    type: z.literal("task.updated"),
    taskId: z.string(),
    title: z.string().optional(),
    status: TaskStatusSchema.optional(),
    summary: z.string().optional(),
    branch: z.string().optional(),
    prUrl: z.string().optional(),
    sessionIds: z.array(z.string()).optional(),
    updatedAt: z.number(),
  }),
  z.object({
    type: z.literal("session.upserted"),
    session: SessionRecordSchema,
  }),
  z.object({
    type: z.literal("session.status_changed"),
    sessionId: z.string(),
    status: SessionStatusSchema,
    blockedReason: z.string().optional(),
    updatedAt: z.number(),
  }),
  z.object({
    type: z.literal("artifact.created"),
    artifact: ArtifactSchema,
  }),
  z.object({
    type: z.literal("artifact.version_published"),
    artifactId: z.string(),
    version: z.number(),
    summary: z.string(),
    contentPath: z.string(),
    reviewStatus: ReviewStatusSchema,
    metadata: ArtifactMetadataSchema.optional(),
    questions: z.array(DecisionQuestionSchema).optional(),
    updatedAt: z.number(),
  }),
  z.object({
    type: z.literal("artifact.metadata_updated"),
    artifactId: z.string(),
    metadata: ArtifactMetadataSchema,
    updatedAt: z.number(),
  }),
  z.object({
    type: z.literal("artifact.question_answered"),
    artifactId: z.string(),
    questionId: z.string(),
    selectedOptionIds: z.array(z.string()),
    updatedAt: z.number(),
  }),
  z.object({
    type: z.literal("comment.created"),
    thread: CommentThreadSchema,
  }),
  z.object({
    type: z.literal("comment.replied"),
    threadId: z.string(),
    reply: CommentReplySchema,
    updatedAt: z.number(),
  }),
  z.object({
    type: z.literal("comment.resolved_changed"),
    threadId: z.string(),
    resolved: z.boolean(),
    updatedAt: z.number(),
  }),
  z.object({
    type: z.literal("artifact.reviewed"),
    artifactId: z.string(),
    version: z.number(),
    verdict: ReviewVerdictSchema,
    reviewStatus: ReviewStatusSchema,
    reviewerNote: z.string().optional(),
    answers: z.record(z.string(), z.array(z.string())),
    targetSessionId: z.string().optional(),
    agentPayload: z.string(),
    reviewedAt: z.number(),
  }),
])

export type HubEventFact = z.infer<typeof HubEventFactSchema>

export interface StoredHubEvent {
  seq: number
  aggregate: string
  at: number
  type: HubEventFact["type"]
  fact: HubEventFact
}
