import type { PeekResult, ProjectFileEntry, TimelineEntry, WorkspaceSnapshot } from "../types.ts"

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)

  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${url}`)
  }

  return res.json()
}

export const webApi = {
  getState: (): Promise<WorkspaceSnapshot> => fetchJson<WorkspaceSnapshot>("/api/state"),

  getTimeline: (projectId: string, sessionId: string): Promise<{ readonly entries: ReadonlyArray<TimelineEntry> }> =>
    fetchJson<{ readonly entries: ReadonlyArray<TimelineEntry> }>(
      `/api/projects/${encodeURIComponent(projectId)}/timeline?sessionId=${encodeURIComponent(sessionId)}`,
    ),

  getFiles: (projectId: string): Promise<{ readonly files: ReadonlyArray<ProjectFileEntry> }> =>
    fetchJson<{ readonly files: ReadonlyArray<ProjectFileEntry> }>(
      `/api/projects/${encodeURIComponent(projectId)}/files`,
    ),

  getFileContent: (projectId: string, relativePath: string): Promise<{ readonly content: string }> =>
    fetchJson<{ readonly content: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(relativePath)}`,
    ),

  saveFileContent: (
    projectId: string,
    relativePath: string,
    content: string,
  ): Promise<{ readonly ok: boolean; readonly files: ReadonlyArray<ProjectFileEntry> }> =>
    fetchJson<{ readonly ok: boolean; readonly files: ReadonlyArray<ProjectFileEntry> }>(
      `/api/projects/${encodeURIComponent(projectId)}/file`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: relativePath, content }),
      },
    ),

  peekSession: (sessionId: string): Promise<PeekResult> =>
    fetchJson<PeekResult>(`/api/sessions/${encodeURIComponent(sessionId)}/peek`),

  sendToSession: (
    sessionId: string,
    message: string,
    attachments: ReadonlyArray<string>,
  ): Promise<{ readonly ok: boolean; readonly entry: TimelineEntry | null; readonly error?: string }> =>
    fetchJson<{ readonly ok: boolean; readonly entry: TimelineEntry | null; readonly error?: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, attachments }),
      },
    ),

  interruptSession: (sessionId: string): Promise<{ readonly ok: boolean; readonly message: string }> =>
    fetchJson<{ readonly ok: boolean; readonly message: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      { method: "POST" },
    ),

  archiveSession: (sessionId: string): Promise<{ readonly ok: boolean; readonly message: string }> =>
    fetchJson<{ readonly ok: boolean; readonly message: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/archive`,
      { method: "POST" },
    ),
}
