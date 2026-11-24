import type { ProjectActivity } from "@vibest/schema/project"
import type { AgentStatus, ExecutionState } from "@vibest/schema/session"

export type KnowledgeCategory = "artifacts" | "docs" | "memories" | "preferences"

export type StageMode = "chat" | "split" | "stage"

export type SessionFilter = "all" | "needs_you" | "working" | "done"

export type ThemeMode = "dark" | "light"

export interface GitBranchState {
  readonly branch: string
  readonly pushed: boolean
  readonly saved: boolean
  readonly why: string
}

export interface SessionItem {
  readonly id: string
  readonly name: string
  readonly agent: string
  readonly harness: string
  readonly provider: string | null
  readonly model: string | null
  readonly status: AgentStatus
  readonly executionState: ExecutionState
  readonly projectId: string
  readonly parentId: string | null
  readonly runtime: string
  readonly machine: string
  readonly worktree: string
  readonly repositoryRoot: string | null
  readonly git: GitBranchState | null
  readonly createdAt: number
  readonly lastActive: number
  readonly startedAt: number | null
  readonly exitedAt: number | null
  readonly task: string | null
  readonly summary: string
  readonly isEntry: boolean
  readonly needsYou: boolean
}

export interface ProjectSummary {
  readonly id: string
  readonly name: string
  readonly directory: string
  readonly entrySessionId: string | null
  readonly activity: ProjectActivity
  readonly machine: string
  readonly activeSubagents: number
  readonly needsYouCount: number
  readonly totalSessions: number
  readonly branch: string
}

export interface MachineLoadSnapshot {
  readonly sampledAt: number
  readonly cpuCount: number
  readonly cpuUtilization: number | null
  readonly memoryTotalBytes: number
  readonly memoryAvailableBytes: number
  readonly workingExecutions: number
}

export interface DaemonStatus {
  readonly connected: boolean
  readonly mode: "live" | "isolated"
  readonly version: string
  readonly socket: string
  readonly load: MachineLoadSnapshot | null
}

export interface ProjectFileEntry {
  readonly id: string
  readonly projectId: string
  readonly category: KnowledgeCategory
  readonly name: string
  readonly relativePath: string
  readonly extension: string
  readonly size: number
  readonly updatedAt: number
  readonly kind: "markdown" | "html" | "excalidraw" | "image" | "video" | "text"
}

export interface TimelineEntry {
  readonly id: string
  readonly sessionId: string
  readonly projectId: string
  readonly role: "user" | "assistant" | "agent" | "system"
  readonly senderLabel: string
  readonly senderSessionId: string | null
  readonly content: string
  readonly createdAt: number
  readonly status: "completed" | "working" | "blocked" | "failed" | "queued"
  readonly attachments: ReadonlyArray<string>
}

export interface PeekResult {
  readonly sessionId: string
  readonly text: string
  readonly terminal: string
  readonly updatedAt: number
}

export interface WorkspaceSnapshot {
  readonly daemon: DaemonStatus
  readonly projects: ReadonlyArray<ProjectSummary>
  readonly sessions: ReadonlyArray<SessionItem>
  readonly filesByProject: Readonly<Record<string, ReadonlyArray<ProjectFileEntry>>>
}

export type StreamPayload =
  | { readonly type: "snapshot"; readonly data: WorkspaceSnapshot }
  | { readonly type: "project"; readonly data: ProjectSummary }
  | { readonly type: "session"; readonly data: SessionItem }
  | { readonly type: "session-ended"; readonly data: { readonly id: string; readonly projectId: string } }
  | {
      readonly type: "files-changed"
      readonly data: { readonly projectId: string; readonly files: ReadonlyArray<ProjectFileEntry> }
    }
  | { readonly type: "timeline-entry"; readonly data: TimelineEntry }
  | { readonly type: "daemon"; readonly data: DaemonStatus }

export type StageItem =
  | { readonly kind: "file"; readonly file: ProjectFileEntry }
  | { readonly kind: "terminal"; readonly sessionId: string }

export interface ParsedAgentReport {
  readonly kind: "agent-report"
  readonly agentId: string
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
