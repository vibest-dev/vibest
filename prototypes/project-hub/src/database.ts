import { Database } from "bun:sqlite"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { z } from "zod"

import { applyFactToReadModel, createReadModelTables, initLedgerSchema } from "./database-reducer.ts"
import {
  ArtifactRowSchema,
  EventRowSchema,
  ProjectRowSchema,
  SessionRowSchema,
  TaskRowSchema,
  ThreadRowSchema,
  extensionForArtifactKind,
  formatAnchorForAgent,
  formatSessionFactsMarkdown,
  hydrateArtifactRow,
  hydrateProjectRow,
  hydrateSessionRow,
  hydrateTaskRow,
  hydrateThreadRow,
  knowledgeCategoryForPath,
  nextReviewStatusForVerdict,
  type AgentReviewPayloadResult,
  type SubmitReviewResult,
} from "./database-rows.ts"
import {
  CommentAnchorSchema,
  HubEventFactSchema,
  type Artifact,
  type ArtifactKind,
  type ArtifactMetadata,
  type BoardViewData,
  type CommentAnchor,
  type CommentThread,
  type DecisionQuestion,
  type HubEventFact,
  type KnowledgeFileEntry,
  type NeedsYouItem,
  type Project,
  type ReviewStatus,
  type ReviewVerdict,
  type SessionRecord,
  type SessionStatus,
  type StoredHubEvent,
  type Task,
  type TaskLaneCard,
  type TaskStatus,
} from "./schema.ts"

export type HubEventListener = (event: StoredHubEvent) => void

export function slugifyText(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return cleaned.length > 0 ? cleaned.slice(0, 64) : "item"
}

export class HubDatabase {
  readonly db: Database
  readonly dataDir: string
  private readonly listeners = new Set<HubEventListener>()

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir)
    fs.mkdirSync(this.dataDir, { recursive: true })
    const dbPath = path.join(this.dataDir, "hub.sqlite")
    this.db = new Database(dbPath, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.initSchema()
  }

  close(): void {
    this.db.close()
  }

  subscribe(listener: HubEventListener): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  projectDir(projectId: string): string {
    const dir = path.join(this.dataDir, "projects", projectId)
    fs.mkdirSync(dir, { recursive: true })

    return dir
  }

  knowledgeDir(projectId: string): string {
    const dir = path.join(this.projectDir(projectId), "knowledge")
    fs.mkdirSync(dir, { recursive: true })

    return dir
  }

  artifactsDir(projectId: string): string {
    const dir = path.join(this.projectDir(projectId), "artifacts")
    fs.mkdirSync(dir, { recursive: true })

    return dir
  }

  private initSchema(): void {
    initLedgerSchema(this.db)
  }

  appendFact(aggregate: string, fact: HubEventFact, at = Date.now()): StoredHubEvent {
    const validated = HubEventFactSchema.parse(fact)
    let insertedSeq = 0

    const tx = this.db.transaction(() => {
      const result = this.db
        .query("INSERT INTO event (aggregate, at, type, data) VALUES (?, ?, ?, ?)")
        .run(aggregate, at, validated.type, JSON.stringify(validated))

      insertedSeq = Number(result.lastInsertRowid)
      applyFactToReadModel(this.db, validated)
    })

    tx()

    const stored: StoredHubEvent = {
      seq: insertedSeq,
      aggregate,
      at,
      type: validated.type,
      fact: validated,
    }

    for (const listener of this.listeners) {
      listener(stored)
    }

    return stored
  }

  rebuildProjectionFromLedger(): number {
    const rawRows = this.db.query("SELECT seq, aggregate, at, type, data FROM event ORDER BY seq ASC").all()
    const rows = z.array(EventRowSchema).parse(rawRows)

    const tx = this.db.transaction(() => {
      this.db.exec(`
        DROP TABLE IF EXISTS comment_thread;
        DROP TABLE IF EXISTS artifact;
        DROP TABLE IF EXISTS session;
        DROP TABLE IF EXISTS task;
        DROP TABLE IF EXISTS project;
      `)
      createReadModelTables(this.db)

      for (const row of rows) {
        const fact = HubEventFactSchema.parse(JSON.parse(row.data))
        applyFactToReadModel(this.db, fact)
      }
    })

    tx()

    return rows.length
  }

  listEvents(limit = 100): StoredHubEvent[] {
    const rawRows = this.db
      .query("SELECT seq, aggregate, at, type, data FROM event ORDER BY seq DESC LIMIT ?")
      .all(limit)

    const rows = z.array(EventRowSchema).parse(rawRows)

    return rows.map((row) => {
      const fact = HubEventFactSchema.parse(JSON.parse(row.data))

      return {
        seq: row.seq,
        aggregate: row.aggregate,
        at: row.at,
        type: fact.type,
        fact,
      }
    })
  }

  listProjects(): Project[] {
    const rows = z.array(ProjectRowSchema).parse(this.db.query("SELECT * FROM project ORDER BY created_at ASC").all())

    return rows.map((row) => hydrateProjectRow(row))
  }

  getProject(projectId: string): Project | undefined {
    const raw = this.db.query("SELECT * FROM project WHERE id = ? OR slug = ?").get(projectId, projectId)

    if (raw === null) return undefined

    return hydrateProjectRow(ProjectRowSchema.parse(raw))
  }

  createProject(input: {
    id?: string
    name: string
    description: string
    repoPath?: string
    vibestProjectDir?: string
    entrySessionId?: string
  }): Project {
    const now = Date.now()

    const project: Project = {
      id: input.id ?? `proj-${crypto.randomUUID().slice(0, 8)}`,
      name: input.name,
      slug: slugifyText(input.name),
      description: input.description,
      ...(input.repoPath !== undefined && { repoPath: input.repoPath }),
      ...(input.vibestProjectDir !== undefined && { vibestProjectDir: input.vibestProjectDir }),
      ...(input.entrySessionId !== undefined && { entrySessionId: input.entrySessionId }),
      createdAt: now,
      updatedAt: now,
    }

    this.projectDir(project.id)
    this.knowledgeDir(project.id)
    this.artifactsDir(project.id)
    this.appendFact(`project:${project.id}`, { type: "project.created", project }, now)

    return project
  }

  listTasks(projectId: string): Task[] {
    const rows = z
      .array(TaskRowSchema)
      .parse(this.db.query("SELECT * FROM task WHERE project_id = ? ORDER BY updated_at DESC").all(projectId))

    return rows.map((row) => hydrateTaskRow(row))
  }

  getTask(taskId: string): Task | undefined {
    const raw = this.db.query("SELECT * FROM task WHERE id = ?").get(taskId)

    if (raw === null) return undefined

    return hydrateTaskRow(TaskRowSchema.parse(raw))
  }

  createTask(input: {
    id?: string
    projectId: string
    title: string
    status?: TaskStatus
    summary: string
    branch?: string
    prUrl?: string
    sessionIds?: string[]
  }): Task {
    const now = Date.now()

    const task: Task = {
      id: input.id ?? `task-${crypto.randomUUID().slice(0, 8)}`,
      projectId: input.projectId,
      title: input.title,
      status: input.status ?? "active",
      summary: input.summary,
      ...(input.branch !== undefined && { branch: input.branch }),
      ...(input.prUrl !== undefined && { prUrl: input.prUrl }),
      sessionIds: input.sessionIds ?? [],
      createdAt: now,
      updatedAt: now,
    }

    this.appendFact(`task:${task.id}`, { type: "task.created", task }, now)

    return task
  }

  updateTask(
    taskId: string,
    patch: {
      title?: string
      status?: TaskStatus
      summary?: string
      branch?: string
      prUrl?: string
      sessionIds?: string[]
    },
  ): Task {
    const existing = this.getTask(taskId)

    if (!existing) throw new Error(`Task not found: ${taskId}`)
    const now = Date.now()
    this.appendFact(`task:${taskId}`, { type: "task.updated", taskId, ...patch, updatedAt: now }, now)
    const updated = this.getTask(taskId)

    if (!updated) throw new Error(`Task disappeared after update: ${taskId}`)

    return updated
  }

  listSessions(projectId: string): SessionRecord[] {
    const rows = z
      .array(SessionRowSchema)
      .parse(this.db.query("SELECT * FROM session WHERE project_id = ? ORDER BY updated_at DESC").all(projectId))

    return rows.map((row) => hydrateSessionRow(row))
  }

  upsertSession(input: {
    id: string
    projectId: string
    taskId?: string
    parentSessionId?: string
    name: string
    agent: string
    harness: string
    model?: string
    directory: string
    status: SessionStatus
    blockedReason?: string
  }): SessionRecord {
    const now = Date.now()
    const session: SessionRecord = { ...input, createdAt: now, updatedAt: now }
    this.appendFact(`session:${session.id}`, { type: "session.upserted", session }, now)

    return session
  }

  updateSessionStatus(sessionId: string, status: SessionStatus, blockedReason?: string): SessionRecord {
    const now = Date.now()
    this.appendFact(
      `session:${sessionId}`,
      {
        type: "session.status_changed",
        sessionId,
        status,
        ...(blockedReason !== undefined && { blockedReason }),
        updatedAt: now,
      },
      now,
    )
    const raw = this.db.query("SELECT * FROM session WHERE id = ?").get(sessionId)

    if (raw === null) throw new Error(`Session not found: ${sessionId}`)

    return hydrateSessionRow(SessionRowSchema.parse(raw))
  }

  listArtifacts(projectId: string): Artifact[] {
    const rows = z
      .array(ArtifactRowSchema)
      .parse(this.db.query("SELECT * FROM artifact WHERE project_id = ? ORDER BY updated_at DESC").all(projectId))

    return rows.map((row) => hydrateArtifactRow(row))
  }

  getArtifact(artifactId: string): Artifact | undefined {
    const raw = this.db.query("SELECT * FROM artifact WHERE id = ? OR slug = ?").get(artifactId, artifactId)

    if (raw === null) return undefined

    return hydrateArtifactRow(ArtifactRowSchema.parse(raw))
  }

  putArtifact(input: {
    id?: string
    projectId: string
    taskId?: string
    slug?: string
    title: string
    kind: ArtifactKind
    summary: string
    content: string
    reviewStatus?: ReviewStatus
    questions?: DecisionQuestion[]
    metadata?: ArtifactMetadata
    authorSessionId?: string
    extraFiles?: Array<{ fileName: string; content: string }>
  }): Artifact {
    const now = Date.now()
    const slug = input.slug ?? slugifyText(input.title)

    const existingBySlugRaw = this.db
      .query("SELECT * FROM artifact WHERE project_id = ? AND slug = ?")
      .get(input.projectId, slug)

    const ext = extensionForArtifactKind(input.kind)

    if (existingBySlugRaw !== null && input.id === undefined) {
      const existing = hydrateArtifactRow(ArtifactRowSchema.parse(existingBySlugRaw))
      const nextVersion = existing.version + 1
      const artifactFolder = path.join(this.artifactsDir(input.projectId), existing.id, `v${nextVersion}`)
      fs.mkdirSync(artifactFolder, { recursive: true })
      const contentPath = path.join(artifactFolder, `index.${ext}`)
      fs.writeFileSync(contentPath, input.content, "utf8")

      for (const extra of input.extraFiles ?? []) {
        fs.writeFileSync(path.join(artifactFolder, path.basename(extra.fileName)), extra.content, "utf8")
      }

      this.appendFact(
        `artifact:${existing.id}`,
        {
          type: "artifact.version_published",
          artifactId: existing.id,
          version: nextVersion,
          summary: input.summary,
          contentPath,
          reviewStatus: input.reviewStatus ?? existing.reviewStatus,
          ...(input.metadata !== undefined && { metadata: input.metadata }),
          ...(input.questions !== undefined && { questions: input.questions }),
          updatedAt: now,
        },
        now,
      )
      const refreshed = this.getArtifact(existing.id)

      if (!refreshed) throw new Error(`Artifact missing after publish: ${existing.id}`)

      return refreshed
    }

    const id = input.id ?? `art-${crypto.randomUUID().slice(0, 8)}`
    const artifactFolder = path.join(this.artifactsDir(input.projectId), id, "v1")
    fs.mkdirSync(artifactFolder, { recursive: true })
    const contentPath = path.join(artifactFolder, `index.${ext}`)
    fs.writeFileSync(contentPath, input.content, "utf8")

    for (const extra of input.extraFiles ?? []) {
      fs.writeFileSync(path.join(artifactFolder, path.basename(extra.fileName)), extra.content, "utf8")
    }

    const artifact: Artifact = {
      id,
      projectId: input.projectId,
      ...(input.taskId !== undefined && { taskId: input.taskId }),
      slug,
      title: input.title,
      kind: input.kind,
      summary: input.summary,
      version: 1,
      reviewStatus: input.reviewStatus ?? "none",
      contentPath,
      questions: input.questions ?? [],
      answers: {},
      metadata: input.metadata ?? {},
      ...(input.authorSessionId !== undefined && { authorSessionId: input.authorSessionId }),
      versions: [{ version: 1, summary: input.summary, contentPath, createdAt: now }],
      createdAt: now,
      updatedAt: now,
    }

    this.appendFact(`artifact:${artifact.id}`, { type: "artifact.created", artifact }, now)

    return artifact
  }

  readArtifactContent(artifactId: string, version?: number, variantId?: string): string {
    const artifact = this.getArtifact(artifactId)

    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`)
    const versionEntry = version !== undefined ? artifact.versions.find((v) => v.version === version) : undefined
    const baseFilePath = versionEntry ? versionEntry.contentPath : artifact.contentPath

    if (variantId !== undefined && artifact.metadata.variants) {
      const variant = artifact.metadata.variants.find((item) => item.id === variantId)

      if (variant) {
        const candidatePath = path.join(path.dirname(baseFilePath), path.basename(variant.fileName))

        if (fs.existsSync(candidatePath)) {
          return fs.readFileSync(candidatePath, "utf8")
        }
      }
    }

    return fs.readFileSync(baseFilePath, "utf8")
  }

  saveArtifactContentInPlace(artifactId: string, content: string): Artifact {
    const artifact = this.getArtifact(artifactId)

    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`)
    fs.writeFileSync(artifact.contentPath, content, "utf8")

    return artifact
  }

  updateArtifactMetadata(artifactId: string, metadata: ArtifactMetadata): Artifact {
    const existing = this.getArtifact(artifactId)

    if (!existing) throw new Error(`Artifact not found: ${artifactId}`)
    const now = Date.now()
    this.appendFact(
      `artifact:${artifactId}`,
      { type: "artifact.metadata_updated", artifactId, metadata, updatedAt: now },
      now,
    )
    const updated = this.getArtifact(artifactId)

    if (!updated) throw new Error(`Artifact missing: ${artifactId}`)

    return updated
  }

  answerQuestion(artifactId: string, questionId: string, selectedOptionIds: string[]): Artifact {
    const existing = this.getArtifact(artifactId)

    if (!existing) throw new Error(`Artifact not found: ${artifactId}`)
    const now = Date.now()
    this.appendFact(
      `artifact:${artifactId}`,
      { type: "artifact.question_answered", artifactId, questionId, selectedOptionIds, updatedAt: now },
      now,
    )
    const updated = this.getArtifact(artifactId)

    if (!updated) throw new Error(`Artifact missing: ${artifactId}`)

    return updated
  }

  listCommentThreads(artifactId: string): CommentThread[] {
    const rows = z
      .array(ThreadRowSchema)
      .parse(
        this.db.query("SELECT * FROM comment_thread WHERE artifact_id = ? ORDER BY pin_number ASC").all(artifactId),
      )

    return rows.map((row) => hydrateThreadRow(row))
  }

  getCommentThread(threadId: string): CommentThread | undefined {
    const raw = this.db.query("SELECT * FROM comment_thread WHERE id = ?").get(threadId)

    if (raw === null) return undefined

    return hydrateThreadRow(ThreadRowSchema.parse(raw))
  }

  addCommentThread(input: { artifactId: string; author?: string; body: string; anchor: CommentAnchor }): CommentThread {
    const artifact = this.getArtifact(input.artifactId)

    if (!artifact) throw new Error(`Artifact not found: ${input.artifactId}`)
    const existingThreads = this.listCommentThreads(artifact.id)
    const maxPin = existingThreads.reduce((highest, item) => Math.max(highest, item.pinNumber), 0)
    const now = Date.now()

    const thread: CommentThread = {
      id: `cmt-${crypto.randomUUID().slice(0, 8)}`,
      projectId: artifact.projectId,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      pinNumber: maxPin + 1,
      author: input.author ?? "owner",
      body: input.body,
      anchor: CommentAnchorSchema.parse(input.anchor),
      resolved: false,
      replies: [],
      createdAt: now,
      updatedAt: now,
    }

    this.appendFact(`artifact:${artifact.id}`, { type: "comment.created", thread }, now)

    return thread
  }

  replyToCommentThread(threadId: string, body: string, author = "owner"): CommentThread {
    const existing = this.getCommentThread(threadId)

    if (!existing) throw new Error(`Comment thread not found: ${threadId}`)
    const now = Date.now()
    this.appendFact(
      `artifact:${existing.artifactId}`,
      {
        type: "comment.replied",
        threadId,
        reply: { id: `rpl-${crypto.randomUUID().slice(0, 8)}`, author, body, createdAt: now },
        updatedAt: now,
      },
      now,
    )
    const updated = this.getCommentThread(threadId)

    if (!updated) throw new Error(`Thread missing: ${threadId}`)

    return updated
  }

  setCommentResolved(threadId: string, resolved: boolean): CommentThread {
    const existing = this.getCommentThread(threadId)

    if (!existing) throw new Error(`Comment thread not found: ${threadId}`)
    const now = Date.now()
    this.appendFact(
      `artifact:${existing.artifactId}`,
      { type: "comment.resolved_changed", threadId, resolved, updatedAt: now },
      now,
    )
    const updated = this.getCommentThread(threadId)

    if (!updated) throw new Error(`Thread missing: ${threadId}`)

    return updated
  }

  buildAgentReviewPayload(
    artifactId: string,
    verdict: ReviewVerdict,
    reviewerNote?: string,
    overrideAnswers?: Artifact["answers"],
  ): AgentReviewPayloadResult {
    const artifact = this.getArtifact(artifactId)

    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`)
    const project = this.getProject(artifact.projectId)
    const threads = this.listCommentThreads(artifact.id)
    const openThreads = threads.flatMap((t) => (t.resolved ? [] : [t]))
    const answers = overrideAnswers ?? artifact.answers

    const targetSessionId =
      verdict === "changes_requested"
        ? (artifact.authorSessionId ?? project?.entrySessionId)
        : (project?.entrySessionId ?? artifact.authorSessionId)

    const lines: string[] = [
      `<vibest-artifact-review artifact="${artifact.id}" slug="${artifact.slug}" kind="${artifact.kind}" version="${artifact.version}" verdict="${verdict}">`,
      `Title: ${artifact.title}`,
      `ContentPath: ${artifact.contentPath}`,
      `RoutedToSession: ${targetSessionId ?? "unassigned"}`,
    ]

    if (artifact.metadata.selectedVariantId) {
      lines.push(`SelectedVariant: ${artifact.metadata.selectedVariantId}`)
    }

    if (reviewerNote && reviewerNote.trim().length > 0) {
      lines.push(`ReviewerNote: ${reviewerNote.trim()}`)
    }

    if (artifact.questions.length > 0) {
      lines.push("", "Decisions:")

      for (const q of artifact.questions) {
        const chosenIds = answers[q.id] ?? []

        const chosenLabels = q.options.flatMap((opt) =>
          chosenIds.includes(opt.id) ? [`${opt.id} (${opt.label})`] : [],
        )

        lines.push(`- [${q.id}] ${q.question} => ${chosenLabels.length > 0 ? chosenLabels.join(", ") : "unanswered"}`)
      }
    }

    if (openThreads.length > 0) {
      lines.push("", `AnchoredComments (${openThreads.length} open):`)

      for (const thread of openThreads) {
        lines.push(`- #${thread.pinNumber} ${formatAnchorForAgent(thread.anchor)}: ${thread.body}`)

        for (const reply of thread.replies) {
          lines.push(`  - reply(${reply.author}): ${reply.body}`)
        }
      }
    }

    lines.push("</vibest-artifact-review>")

    return {
      payload: lines.join("\n"),
      targetSessionId,
    }
  }

  submitReview(input: {
    artifactId: string
    verdict: ReviewVerdict
    reviewerNote?: string
    answers?: Artifact["answers"]
  }): SubmitReviewResult {
    const existing = this.getArtifact(input.artifactId)

    if (!existing) throw new Error(`Artifact not found: ${input.artifactId}`)

    const mergedAnswers: Artifact["answers"] = {
      ...existing.answers,
      ...input.answers,
    }

    const nextReviewStatus = nextReviewStatusForVerdict(input.verdict, existing.reviewStatus)

    const { payload, targetSessionId } = this.buildAgentReviewPayload(
      existing.id,
      input.verdict,
      input.reviewerNote,
      mergedAnswers,
    )

    const now = Date.now()
    this.appendFact(
      `artifact:${existing.id}`,
      {
        type: "artifact.reviewed",
        artifactId: existing.id,
        version: existing.version,
        verdict: input.verdict,
        reviewStatus: nextReviewStatus,
        ...(input.reviewerNote !== undefined && { reviewerNote: input.reviewerNote }),
        answers: mergedAnswers,
        ...(targetSessionId !== undefined && { targetSessionId }),
        agentPayload: payload,
        reviewedAt: now,
      },
      now,
    )

    const updated = this.getArtifact(existing.id)

    if (!updated) throw new Error(`Artifact missing after review: ${existing.id}`)

    return {
      artifact: updated,
      agentPayload: payload,
      targetSessionId,
    }
  }

  getBoard(projectId: string): BoardViewData {
    const project = this.getProject(projectId)

    if (!project) throw new Error(`Project not found: ${projectId}`)

    const tasks = this.listTasks(project.id)
    const sessions = this.listSessions(project.id)
    const artifacts = this.listArtifacts(project.id)

    const taskMap = new Map<string, Task>()

    for (const task of tasks) {
      taskMap.set(task.id, task)
    }

    const needsYou: NeedsYouItem[] = []

    for (const artifact of artifacts) {
      if (artifact.reviewStatus !== "requested") continue
      const threads = this.listCommentThreads(artifact.id)
      let openCommentCount = 0

      for (const thread of threads) {
        if (!thread.resolved) openCommentCount += 1
      }

      let unansweredQuestionCount = 0

      for (const q of artifact.questions) {
        const selected = artifact.answers[q.id]

        if (!selected || selected.length === 0) unansweredQuestionCount += 1
      }

      const parentTask = artifact.taskId ? taskMap.get(artifact.taskId) : undefined
      needsYou.push({
        itemType: "artifact_review",
        id: `ny-art-${artifact.id}`,
        projectId: project.id,
        ...(artifact.taskId !== undefined && { taskId: artifact.taskId }),
        ...(parentTask !== undefined && { taskTitle: parentTask.title }),
        artifact,
        openCommentCount,
        unansweredQuestionCount,
        updatedAt: artifact.updatedAt,
      })
    }

    for (const session of sessions) {
      if (session.status !== "blocked") continue
      const parentTask = session.taskId ? taskMap.get(session.taskId) : undefined
      needsYou.push({
        itemType: "blocked_session",
        id: `ny-ses-${session.id}`,
        projectId: project.id,
        ...(session.taskId !== undefined && { taskId: session.taskId }),
        ...(parentTask !== undefined && { taskTitle: parentTask.title }),
        session,
        updatedAt: session.updatedAt,
      })
    }

    needsYou.sort((a, b) => b.updatedAt - a.updatedAt)

    const buildLaneCard = (task: Task): TaskLaneCard => ({
      task,
      sessions: sessions.flatMap((s) => (s.taskId === task.id || task.sessionIds.includes(s.id) ? [s] : [])),
      artifacts: artifacts.flatMap((a) => (a.taskId === task.id ? [a] : [])),
    })

    const inProgress = tasks.flatMap((t) => (t.status === "active" ? [buildLaneCard(t)] : []))
    const doneTasks = tasks.flatMap((t) => (t.status === "done" ? [buildLaneCard(t)] : []))

    const doneStandaloneArtifacts = artifacts.flatMap((a) =>
      a.taskId === undefined && a.reviewStatus === "approved" ? [a] : [],
    )

    return {
      project,
      needsYou,
      inProgress,
      doneTasks,
      doneStandaloneArtifacts,
      sessionFactsMarkdown: formatSessionFactsMarkdown(project, needsYou, inProgress),
    }
  }

  listKnowledgeFiles(projectId: string): KnowledgeFileEntry[] {
    const root = this.knowledgeDir(projectId)
    const entries: KnowledgeFileEntry[] = []

    const prefPath = path.join(root, "preferences.md")

    if (fs.existsSync(prefPath)) {
      const stat = fs.statSync(prefPath)
      entries.push({
        relativePath: "preferences.md",
        category: "preferences",
        sizeBytes: stat.size,
        updatedAt: Math.floor(stat.mtimeMs),
      })
    }

    const walkSubfolder = (folder: "memories" | "docs", currentRel: string) => {
      const absDir = path.join(root, currentRel)

      if (!fs.existsSync(absDir)) return
      const names = fs.readdirSync(absDir).sort()

      for (const name of names) {
        if (name.startsWith(".")) continue
        const rel = path.posix.join(currentRel, name)
        const abs = path.join(root, rel)
        const stat = fs.statSync(abs)

        if (stat.isDirectory()) {
          walkSubfolder(folder, rel)
        } else if (name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".json")) {
          entries.push({
            relativePath: rel,
            category: folder,
            sizeBytes: stat.size,
            updatedAt: Math.floor(stat.mtimeMs),
          })
        }
      }
    }

    walkSubfolder("memories", "memories")
    walkSubfolder("docs", "docs")

    return entries
  }

  readKnowledgeFile(projectId: string, relativePath: string): string {
    const safePath = this.resolveKnowledgePath(projectId, relativePath)

    if (!fs.existsSync(safePath)) throw new Error(`Knowledge file not found: ${relativePath}`)

    return fs.readFileSync(safePath, "utf8")
  }

  writeKnowledgeFile(projectId: string, relativePath: string, content: string): KnowledgeFileEntry {
    const safePath = this.resolveKnowledgePath(projectId, relativePath)
    fs.mkdirSync(path.dirname(safePath), { recursive: true })
    fs.writeFileSync(safePath, content, "utf8")
    const stat = fs.statSync(safePath)
    const category = knowledgeCategoryForPath(relativePath)

    return {
      relativePath,
      category,
      sizeBytes: stat.size,
      updatedAt: Math.floor(stat.mtimeMs),
    }
  }

  private resolveKnowledgePath(projectId: string, relativePath: string): string {
    const normalized = path.posix.normalize(relativePath).replace(/^\/+/, "")

    if (normalized !== "preferences.md" && !normalized.startsWith("memories/") && !normalized.startsWith("docs/")) {
      throw new Error(`Invalid knowledge path: ${relativePath}`)
    }

    const root = this.knowledgeDir(projectId)
    const resolved = path.resolve(root, normalized)

    if (!resolved.startsWith(root + path.sep)) {
      throw new Error(`Path escapes knowledge root: ${relativePath}`)
    }

    return resolved
  }
}
