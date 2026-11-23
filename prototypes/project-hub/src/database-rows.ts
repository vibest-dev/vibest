import fs from "node:fs"
import path from "node:path"

import { z } from "zod"

import {
  ArtifactMetadataSchema,
  ArtifactSchema,
  ArtifactVersionRecordSchema,
  CommentAnchorSchema,
  CommentReplySchema,
  CommentThreadSchema,
  DecisionQuestionSchema,
  ProjectSchema,
  ReviewStatusSchema,
  SessionRecordSchema,
  SessionStatusSchema,
  TaskSchema,
  TaskStatusSchema,
  type Artifact,
  type ArtifactKind,
  type CommentAnchor,
  type CommentThread,
  type KnowledgeFileEntry,
  type NeedsYouItem,
  type Project,
  type ReviewStatus,
  type ReviewVerdict,
  type SessionRecord,
  type Task,
  type TaskLaneCard,
} from "./schema.ts"

export const EventRowSchema = z.object({
  seq: z.number(),
  aggregate: z.string(),
  at: z.number(),
  type: z.string(),
  data: z.string(),
})

export const ProjectRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  repo_path: z.string().nullable(),
  vibest_project_dir: z.string().nullable(),
  entry_session_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
})

export const TaskRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  status: TaskStatusSchema,
  summary: z.string(),
  branch: z.string().nullable(),
  pr_url: z.string().nullable(),
  session_ids_json: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
})

export const SessionRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  task_id: z.string().nullable(),
  parent_session_id: z.string().nullable(),
  name: z.string(),
  agent: z.string(),
  harness: z.string(),
  model: z.string().nullable(),
  directory: z.string(),
  status: SessionStatusSchema,
  blocked_reason: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
})

export const ArtifactRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  task_id: z.string().nullable(),
  slug: z.string(),
  title: z.string(),
  kind: z.enum(["markdown", "html", "whiteboard", "verify"]),
  summary: z.string(),
  version: z.number(),
  review_status: ReviewStatusSchema,
  content_path: z.string(),
  questions_json: z.string(),
  answers_json: z.string(),
  metadata_json: z.string(),
  author_session_id: z.string().nullable(),
  last_review_payload: z.string().nullable(),
  versions_json: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
})

export const ThreadRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  artifact_id: z.string(),
  artifact_version: z.number(),
  pin_number: z.number(),
  author: z.string(),
  body: z.string(),
  anchor_json: z.string(),
  resolved: z.number(),
  replies_json: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
})

const StringArraySchema = z.array(z.string())
const AnswersMapSchema = z.record(z.string(), z.array(z.string()))
const QuestionsArraySchema = z.array(DecisionQuestionSchema)
const VersionsArraySchema = z.array(ArtifactVersionRecordSchema)
const RepliesArraySchema = z.array(CommentReplySchema)

export interface AgentReviewPayloadResult {
  payload: string
  targetSessionId: string | undefined
}

export interface SubmitReviewResult {
  artifact: Artifact
  agentPayload: string
  targetSessionId: string | undefined
}

export function extensionForArtifactKind(kind: ArtifactKind): string {
  switch (kind) {
    case "html":
      return "html"
    case "whiteboard":
      return "excalidraw"
    case "markdown":
    case "verify":
      return "md"
  }
}

export function nextReviewStatusForVerdict(verdict: ReviewVerdict, current: ReviewStatus): ReviewStatus {
  switch (verdict) {
    case "approved":
      return "approved"
    case "changes_requested":
      return "changes_requested"
    case "commented":
      return current
  }
}

export function previewVerdictForStatus(status: ReviewStatus): ReviewVerdict {
  switch (status) {
    case "approved":
      return "approved"
    case "changes_requested":
      return "changes_requested"
    case "none":
    case "requested":
      return "commented"
  }
}

export function knowledgeCategoryForPath(relativePath: string): KnowledgeFileEntry["category"] {
  if (relativePath === "preferences.md") return "preferences"

  if (relativePath.startsWith("memories/")) return "memories"

  return "docs"
}

export function assertSafeIdentifier(rawValue: string, fieldLabel: string): string {
  const trimmed = rawValue.trim()

  if (
    trimmed.length === 0 ||
    trimmed.length > 128 ||
    trimmed === "." ||
    trimmed === ".." ||
    !/^[a-zA-Z0-9._-]+$/.test(trimmed)
  ) {
    throw new Error(`Invalid ${fieldLabel}: ${rawValue}`)
  }

  return trimmed
}

export function resolveContainedPath(rootDir: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(rootDir)

  for (const segment of segments) {
    if (segment.length === 0 || segment.includes("\0")) {
      throw new Error("Invalid path segment")
    }
  }

  const resolvedTarget = path.resolve(resolvedRoot, ...segments)

  if (!resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes root directory: ${segments.join("/")}`)
  }

  return resolvedTarget
}

export interface SafeKnowledgePathResolution {
  readonly resolvedPath: string
  readonly canonicalRelativePath: string
  readonly category: KnowledgeFileEntry["category"]
}

export function resolveSafeKnowledgeFilePath(knowledgeRoot: string, relativePath: string): SafeKnowledgePathResolution {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    relativePath.endsWith("/")
  ) {
    throw new Error(`Invalid knowledge path: ${relativePath}`)
  }

  const normalized = path.posix.normalize(relativePath).replace(/^\/+/, "")

  if (normalized.endsWith("/") || normalized === "." || normalized === ".." || normalized.includes("../")) {
    throw new Error(`Invalid knowledge path: ${relativePath}`)
  }

  const isPreferences = normalized === "preferences.md"
  const isMemoryDoc = normalized.startsWith("memories/") && normalized.length > "memories/".length
  const isDesignDoc = normalized.startsWith("docs/") && normalized.length > "docs/".length

  if (!isPreferences && !isMemoryDoc && !isDesignDoc) {
    throw new Error(`Invalid knowledge path: ${relativePath}`)
  }

  if (!/\.(md|txt|json)$/.test(normalized)) {
    throw new Error(`Unsupported knowledge file extension: ${relativePath}`)
  }

  const resolvedPath = resolveContainedPath(knowledgeRoot, normalized)

  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`Knowledge path points to a directory: ${relativePath}`)
  }

  const resolvedRoot = path.resolve(knowledgeRoot)
  let ancestor = path.dirname(resolvedPath)

  while (ancestor.startsWith(resolvedRoot + path.sep)) {
    if (fs.existsSync(ancestor) && !fs.statSync(ancestor).isDirectory()) {
      throw new Error(`Knowledge parent path is not a directory: ${relativePath}`)
    }

    ancestor = path.dirname(ancestor)
  }

  return {
    resolvedPath,
    canonicalRelativePath: normalized,
    category: knowledgeCategoryForPath(normalized),
  }
}

export function hydrateProjectRow(row: z.infer<typeof ProjectRowSchema>): Project {
  return ProjectSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    ...(row.repo_path !== null && { repoPath: row.repo_path }),
    ...(row.vibest_project_dir !== null && { vibestProjectDir: row.vibest_project_dir }),
    ...(row.entry_session_id !== null && { entrySessionId: row.entry_session_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function hydrateTaskRow(row: z.infer<typeof TaskRowSchema>): Task {
  return TaskSchema.parse({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    ...(row.branch !== null && { branch: row.branch }),
    ...(row.pr_url !== null && { prUrl: row.pr_url }),
    sessionIds: StringArraySchema.parse(JSON.parse(row.session_ids_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function hydrateSessionRow(row: z.infer<typeof SessionRowSchema>): SessionRecord {
  return SessionRecordSchema.parse({
    id: row.id,
    projectId: row.project_id,
    ...(row.task_id !== null && { taskId: row.task_id }),
    ...(row.parent_session_id !== null && { parentSessionId: row.parent_session_id }),
    name: row.name,
    agent: row.agent,
    harness: row.harness,
    ...(row.model !== null && { model: row.model }),
    directory: row.directory,
    status: row.status,
    ...(row.blocked_reason !== null && { blockedReason: row.blocked_reason }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function hydrateArtifactRow(row: z.infer<typeof ArtifactRowSchema>): Artifact {
  return ArtifactSchema.parse({
    id: row.id,
    projectId: row.project_id,
    ...(row.task_id !== null && { taskId: row.task_id }),
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    summary: row.summary,
    version: row.version,
    reviewStatus: row.review_status,
    contentPath: row.content_path,
    questions: QuestionsArraySchema.parse(JSON.parse(row.questions_json)),
    answers: AnswersMapSchema.parse(JSON.parse(row.answers_json)),
    metadata: ArtifactMetadataSchema.parse(JSON.parse(row.metadata_json)),
    ...(row.author_session_id !== null && { authorSessionId: row.author_session_id }),
    ...(row.last_review_payload !== null && { lastReviewPayload: row.last_review_payload }),
    versions: VersionsArraySchema.parse(JSON.parse(row.versions_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function hydrateThreadRow(row: z.infer<typeof ThreadRowSchema>): CommentThread {
  return CommentThreadSchema.parse({
    id: row.id,
    projectId: row.project_id,
    artifactId: row.artifact_id,
    artifactVersion: row.artifact_version,
    pinNumber: row.pin_number,
    author: row.author,
    body: row.body,
    anchor: CommentAnchorSchema.parse(JSON.parse(row.anchor_json)),
    resolved: row.resolved === 1,
    replies: RepliesArraySchema.parse(JSON.parse(row.replies_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function formatAnchorForAgent(anchor: CommentAnchor): string {
  switch (anchor.kind) {
    case "dom":
      return `dom(variant="${anchor.variantId}", selector="${anchor.selector}", tag="${anchor.tagName}", text="${anchor.textPreview}", x=${anchor.xRatio.toFixed(3)}, y=${anchor.yRatio.toFixed(3)})`
    case "region":
      return `region(variant="${anchor.variantId}", style="${anchor.regionStyle}", x=${anchor.xRatio.toFixed(3)}, y=${anchor.yRatio.toFixed(3)}, w=${anchor.wRatio.toFixed(3)}, h=${anchor.hRatio.toFixed(3)})`
    case "whiteboard":
      return `whiteboard(elements=[${anchor.elementIds.join(", ")}], labels=[${anchor.elementLabels.join(", ")}])`
    case "quote":
      return `quote(heading="${anchor.blockHeading ?? "document"}", text=${JSON.stringify(anchor.quote)})`
    case "verify":
      return `verify(section="${anchor.section}"${anchor.gateId ? `, gate="${anchor.gateId}"` : ""})`
  }
}

export function formatSessionFactsMarkdown(
  project: Project,
  needsYou: NeedsYouItem[],
  inProgress: TaskLaneCard[],
): string {
  const lines: string[] = [
    `## Project Hub Snapshot (${project.name})`,
    `- Project ID: \`${project.id}\`${project.entrySessionId ? ` | Entry session: \`${project.entrySessionId}\`` : ""}`,
    `- Triage Queue (\`Needs You\`): ${needsYou.length} item(s)`,
  ]

  for (const item of needsYou) {
    if (item.itemType === "artifact_review") {
      lines.push(
        `  - [Review Requested] \`${item.artifact.slug}\` v${item.artifact.version} (${item.artifact.kind}): ${item.artifact.title} (${item.openCommentCount} open comments, ${item.unansweredQuestionCount} unanswered questions)`,
      )
    } else {
      lines.push(
        `  - [Blocked Session] \`${item.session.id}\` (${item.session.name} / ${item.session.harness}): ${item.session.blockedReason ?? "awaiting user action"}`,
      )
    }
  }

  lines.push(`- Active Workstreams (\`In Progress\`): ${inProgress.length} task(s)`)

  for (const card of inProgress) {
    const branchTag = card.task.branch ? ` [${card.task.branch}]` : ""
    const prTag = card.task.prUrl ? ` (${card.task.prUrl})` : ""
    lines.push(`  - \`${card.task.id}\`: **${card.task.title}**${branchTag}${prTag}: ${card.task.summary}`)
  }

  lines.push(
    `- Hub CLI: \`bun prototypes/project-hub/src/cli.ts board --project ${project.id}\` | \`artifact put <kind> <file> --request-review\``,
  )

  return lines.join("\n")
}
