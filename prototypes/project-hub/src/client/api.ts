import type {
  Artifact,
  ArtifactKind,
  BoardViewData,
  CommentAnchor,
  CommentThread,
  KnowledgeFileEntry,
  Project,
  ReviewVerdict,
  SessionRecord,
  SessionStatus,
  Task,
  TaskStatus,
} from "../schema.ts"

export interface ProjectSummary extends Project {
  needsYouCount: number
  inProgressCount: number
}

export interface ArtifactWithCount extends Artifact {
  openCommentCount: number
}

export interface ArtifactDetailResponse {
  artifact: Artifact
  content: string
  threads: CommentThread[]
  agentPayloadPreview: string
  targetSessionId: string | null
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  })

  const data = await response.json()

  if (!response.ok) {
    const msg =
      data !== null && "error" in data && String(data.error).length > 0
        ? String(data.error)
        : `Request failed (${response.status})`

    throw new Error(msg)
  }

  return data
}

export const hubApi = {
  listProjects: () =>
    requestJson<{ projects: ProjectSummary[]; detectedVibestProjectDir: string | null }>("/api/projects"),

  createProject: (body: { name: string; description: string; repoPath?: string }) =>
    requestJson<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  importVibestProject: (body: { name?: string; vibestProjectDir: string }) =>
    requestJson<{ project: Project; copiedKnowledgeFiles: number; importedSessions: number }>(
      "/api/projects/import-vibest",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),

  getBoard: (projectId: string) => requestJson<BoardViewData>(`/api/projects/${encodeURIComponent(projectId)}/board`),

  listArtifacts: (projectId: string) =>
    requestJson<{ artifacts: ArtifactWithCount[] }>(`/api/projects/${encodeURIComponent(projectId)}/artifacts`),

  getSessionsView: (projectId: string) =>
    requestJson<{
      sessions: SessionRecord[]
      tasks: Task[]
      sessionFactsMarkdown: string
    }>(`/api/projects/${encodeURIComponent(projectId)}/sessions`),

  updateSessionStatus: (sessionId: string, status: SessionStatus, blockedReason?: string) =>
    requestJson<{ session: SessionRecord }>(`/api/sessions/${encodeURIComponent(sessionId)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status, ...(blockedReason !== undefined && { blockedReason }) }),
    }),

  listKnowledgeFiles: (projectId: string) =>
    requestJson<{ files: KnowledgeFileEntry[] }>(`/api/projects/${encodeURIComponent(projectId)}/knowledge`),

  readKnowledgeFile: (projectId: string, relativePath: string) =>
    requestJson<{ relativePath: string; content: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/knowledge?file=${encodeURIComponent(relativePath)}`,
    ),

  saveKnowledgeFile: (projectId: string, relativePath: string, content: string) =>
    requestJson<{ entry: KnowledgeFileEntry }>(`/api/projects/${encodeURIComponent(projectId)}/knowledge`, {
      method: "PUT",
      body: JSON.stringify({ relativePath, content }),
    }),

  createTask: (body: { projectId: string; title: string; summary: string; branch?: string; prUrl?: string }) =>
    requestJson<{ task: Task }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateTask: (
    taskId: string,
    body: { status?: TaskStatus; summary?: string; title?: string; branch?: string; prUrl?: string },
  ) =>
    requestJson<{ task: Task }>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  createArtifact: (body: {
    projectId: string
    taskId?: string
    title: string
    kind: ArtifactKind
    summary: string
    content: string
    reviewStatus?: "none" | "requested"
  }) =>
    requestJson<{ artifact: Artifact }>("/api/artifacts", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getArtifactDetail: (artifactId: string, version?: number, variant?: string) => {
    const params = new URLSearchParams()

    if (version !== undefined) params.set("version", String(version))

    if (variant !== undefined) params.set("variant", variant)
    const qs = params.toString()

    return requestJson<ArtifactDetailResponse>(`/api/artifacts/${encodeURIComponent(artifactId)}${qs ? `?${qs}` : ""}`)
  },

  saveArtifactContent: (
    artifactId: string,
    body: { content: string; publishNewVersion?: boolean; summary?: string; requestReview?: boolean },
  ) =>
    requestJson<{ artifact: Artifact; savedAt?: number }>(`/api/artifacts/${encodeURIComponent(artifactId)}/content`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  applyWhiteboardTemplate: (
    artifactId: string,
    preset: "vibest-architecture" | "event-pipeline" | "multi-agent-review",
  ) =>
    requestJson<{ content: string }>(`/api/artifacts/${encodeURIComponent(artifactId)}/whiteboard-template`, {
      method: "POST",
      body: JSON.stringify({ preset }),
    }),

  selectVariant: (artifactId: string, selectedVariantId: string) =>
    requestJson<{ artifact: Artifact }>(`/api/artifacts/${encodeURIComponent(artifactId)}/variant`, {
      method: "PATCH",
      body: JSON.stringify({ selectedVariantId }),
    }),

  answerQuestion: (artifactId: string, questionId: string, selectedOptionIds: string[]) =>
    requestJson<{ artifact: Artifact; agentPayloadPreview: string }>(
      `/api/artifacts/${encodeURIComponent(artifactId)}/answers`,
      {
        method: "POST",
        body: JSON.stringify({ questionId, selectedOptionIds }),
      },
    ),

  addComment: (artifactId: string, body: { body: string; anchor: CommentAnchor; author?: string }) =>
    requestJson<{ thread: CommentThread; agentPayloadPreview: string }>(
      `/api/artifacts/${encodeURIComponent(artifactId)}/comments`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),

  replyComment: (threadId: string, body: string) =>
    requestJson<{ thread: CommentThread }>(`/api/comments/${encodeURIComponent(threadId)}/replies`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),

  setCommentResolved: (threadId: string, resolved: boolean) =>
    requestJson<{ thread: CommentThread }>(`/api/comments/${encodeURIComponent(threadId)}/resolve`, {
      method: "PATCH",
      body: JSON.stringify({ resolved }),
    }),

  submitReview: (
    artifactId: string,
    body: {
      verdict: ReviewVerdict
      reviewerNote?: string
      deliverViaVibestSend?: boolean
    },
  ) =>
    requestJson<{
      artifact: Artifact
      agentPayload: string
      targetSessionId: string | null
      delivery: { attempted: boolean; delivered: boolean; detail: string }
    }>(`/api/artifacts/${encodeURIComponent(artifactId)}/review`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
}
