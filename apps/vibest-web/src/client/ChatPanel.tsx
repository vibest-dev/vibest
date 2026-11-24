import {
  AtSign,
  Bot,
  ChevronDown,
  ChevronRight,
  Columns2,
  FileText,
  GitBranch,
  MessageSquare,
  PanelRight,
  Send,
  Sparkles,
  Terminal,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { renderSafeMarkdownHtml } from "../markdown-safe.ts"
import type {
  ParsedAgentReport,
  ProjectFileEntry,
  ProjectSummary,
  SessionItem,
  StageMode,
  TimelineEntry,
} from "../types.ts"
import { parseVibestMessageBlocks } from "../xml-parser.ts"

function formatTime(ms: number): string {
  const date = new Date(ms)

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function AgentReportCard(props: {
  readonly report: ParsedAgentReport
  readonly session: SessionItem | undefined
  readonly onPeekSession: (sessionId: string) => void
  readonly onFocusSession: (sessionId: string) => void
}) {
  const { report, session, onPeekSession, onFocusSession } = props
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="agent-report-card" data-testid={`agent-report-card-${report.agentId.slice(0, 8)}`}>
      <div className="agent-report-head">
        <button
          type="button"
          className="agent-report-toggle"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          <Bot size={13} className="agent-report-icon" aria-hidden="true" />
          <span className="agent-report-name">{session?.name ?? `agent-${report.agentId.slice(0, 8)}`}</span>
          <span className="agent-report-id tabular-nums">{report.agentId.slice(0, 8)}</span>
          {session?.git?.branch ? (
            <span className="meta-chip meta-branch">
              <GitBranch size={10} aria-hidden="true" />
              {session.git.branch}
            </span>
          ) : null}
        </button>

        <div className="agent-report-actions">
          <button type="button" className="btn-ghost btn-xs" onClick={() => onPeekSession(report.agentId)}>
            <Terminal size={11} aria-hidden="true" />
            Peek Terminal
          </button>
          <button type="button" className="btn-ghost btn-xs" onClick={() => onFocusSession(report.agentId)}>
            Open Branch
          </button>
        </div>
      </div>

      <div className="agent-report-summary">{report.firstLine}</div>

      {expanded && report.details.length > 0 && (
        <div
          className="agent-report-details markdown-prose"
          dangerouslySetInnerHTML={{ __html: renderSafeMarkdownHtml(report.details) }}
        />
      )}
    </div>
  )
}

export function ChatPanel(props: {
  readonly project: ProjectSummary | null
  readonly sessions: ReadonlyArray<SessionItem>
  readonly activeSessionId: string | null
  readonly targetSessionId: string | null
  readonly timeline: ReadonlyArray<TimelineEntry>
  readonly projectFiles: ReadonlyArray<ProjectFileEntry>
  readonly stageMode: StageMode
  readonly hasStageItem: boolean
  readonly composerText: string
  readonly attachedPaths: ReadonlyArray<string>
  readonly sending: boolean
  readonly onStageModeChange: (mode: StageMode) => void
  readonly onTargetSessionChange: (sessionId: string) => void
  readonly onComposerTextChange: (text: string) => void
  readonly onAddAttachment: (relativePath: string) => void
  readonly onRemoveAttachment: (relativePath: string) => void
  readonly onSend: () => void
  readonly onPeekSession: (sessionId: string) => void
  readonly onFocusSession: (sessionId: string) => void
}) {
  const {
    project,
    sessions,
    activeSessionId,
    targetSessionId,
    timeline,
    projectFiles,
    stageMode,
    hasStageItem,
    composerText,
    attachedPaths,
    sending,
    onStageModeChange,
    onTargetSessionChange,
    onComposerTextChange,
    onAddAttachment,
    onRemoveAttachment,
    onSend,
    onPeekSession,
    onFocusSession,
  } = props

  const [showAtPicker, setShowAtPicker] = useState(false)
  const [atFilter, setAtFilter] = useState("")
  const streamEndRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const sessionById = useMemo(() => {
    const map = new Map<string, SessionItem>()

    for (const s of sessions) {
      map.set(s.id, s)
    }

    return map
  }, [sessions])

  const activeSession = activeSessionId ? sessionById.get(activeSessionId) : undefined

  const filteredFiles = useMemo(() => {
    const q = atFilter.trim().toLowerCase()

    return projectFiles.filter(
      (f) =>
        !attachedPaths.includes(f.relativePath) &&
        (q.length === 0 || f.relativePath.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)),
    )
  }, [projectFiles, attachedPaths, atFilter])

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [timeline.length])

  useEffect(() => {
    const el = textareaRef.current

    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(180, Math.max(44, el.scrollHeight))}px`
  }, [composerText])

  return (
    <section className="panel panel-chat" data-testid="chat-panel">
      <header className="panel-header chat-header">
        <div className="panel-title-group">
          <MessageSquare size={14} className="panel-icon" aria-hidden="true" />
          <span className="panel-title">Vibest/{project?.name ?? "workspace"}</span>
          {project?.branch ? (
            <span className="meta-chip meta-branch">
              <GitBranch size={11} aria-hidden="true" />
              {project.branch}
            </span>
          ) : null}
          {activeSession ? (
            <span className="meta-chip">
              {activeSession.harness}
              {activeSession.model ? ` · ${activeSession.model}` : ""}
            </span>
          ) : null}
        </div>

        <div className="segmented" role="group" aria-label="Center workspace layout">
          <button
            type="button"
            data-testid="mode-chat-btn"
            className={`segmented-btn ${stageMode === "chat" ? "is-active" : ""}`}
            onClick={() => onStageModeChange("chat")}
          >
            <MessageSquare size={12} aria-hidden="true" />
            Chat
          </button>
          <button
            type="button"
            data-testid="mode-split-btn"
            className={`segmented-btn ${stageMode === "split" ? "is-active" : ""}`}
            disabled={!hasStageItem}
            onClick={() => onStageModeChange("split")}
          >
            <Columns2 size={12} aria-hidden="true" />
            Split
          </button>
          <button
            type="button"
            data-testid="mode-stage-btn"
            className={`segmented-btn ${stageMode === "stage" ? "is-active" : ""}`}
            disabled={!hasStageItem}
            onClick={() => onStageModeChange("stage")}
          >
            <PanelRight size={12} aria-hidden="true" />
            Stage
          </button>
        </div>
      </header>

      <div className="panel-scroll chat-stream" data-testid="chat-stream">
        {timeline.map((entry) => {
          const blocks = parseVibestMessageBlocks(entry.content)

          return (
            <article key={entry.id} className={`chat-turn is-${entry.role}`} data-testid={`chat-turn-${entry.id}`}>
              <div className="chat-turn-meta">
                <span className="chat-sender">{entry.senderLabel}</span>
                <span className="chat-time tabular-nums">{formatTime(entry.createdAt)}</span>
                {entry.status === "working" && <span className="badge badge-blue">Working</span>}
                {entry.status === "blocked" && <span className="badge badge-amber">Needs You</span>}
              </div>

              {entry.attachments.length > 0 && (
                <div className="turn-attachments">
                  {entry.attachments.map((att) => (
                    <span key={att} className="context-chip is-static">
                      <FileText size={11} aria-hidden="true" />@{att}
                    </span>
                  ))}
                </div>
              )}

              <div className="chat-turn-body">
                {blocks.map((block, idx) => {
                  if (block.kind === "agent-report") {
                    return (
                      <AgentReportCard
                        key={`${entry.id}-rep-${idx}`}
                        report={block}
                        session={sessionById.get(block.agentId)}
                        onPeekSession={onPeekSession}
                        onFocusSession={onFocusSession}
                      />
                    )
                  }

                  if (block.kind === "system-notice") {
                    return (
                      <div key={`${entry.id}-sys-${idx}`} className="system-notice-card">
                        <Sparkles size={12} aria-hidden="true" />
                        <span>{block.body}</span>
                      </div>
                    )
                  }

                  return (
                    <div
                      key={`${entry.id}-txt-${idx}`}
                      className="markdown-prose"
                      dangerouslySetInnerHTML={{ __html: renderSafeMarkdownHtml(block.text) }}
                    />
                  )
                })}
              </div>
            </article>
          )
        })}

        {timeline.length === 0 && (
          <div className="empty-state">
            Select a session or send a message below to orchestrate agents in {project?.name ?? "this project"}.
          </div>
        )}
        <div ref={streamEndRef} />
      </div>

      <div className="composer-dock" data-testid="composer-dock">
        {showAtPicker && (
          <div className="at-picker-popover" data-testid="at-picker-popover">
            <div className="at-picker-head">
              <input
                type="text"
                className="search-input"
                placeholder="Attach artifact, doc, or memory..."
                value={atFilter}
                onChange={(ev) => setAtFilter(ev.target.value)}
                autoFocus
              />
              <button type="button" className="icon-btn" onClick={() => setShowAtPicker(false)}>
                <X size={13} aria-hidden="true" />
              </button>
            </div>
            <div className="at-picker-list">
              {filteredFiles.slice(0, 10).map((file) => (
                <button
                  key={file.id}
                  type="button"
                  className="at-picker-item"
                  data-testid={`at-pick-${file.name}`}
                  onClick={() => {
                    onAddAttachment(file.relativePath)
                    setShowAtPicker(false)
                    setAtFilter("")
                  }}
                >
                  <FileText size={12} aria-hidden="true" />
                  <span className="at-picker-path">{file.relativePath}</span>
                  <span className="file-ext-pill">{file.category}</span>
                </button>
              ))}
              {filteredFiles.length === 0 && <div className="empty-state">No matching files</div>}
            </div>
          </div>
        )}

        {attachedPaths.length > 0 && (
          <div className="composer-chips" data-testid="composer-chips">
            {attachedPaths.map((rel) => (
              <span key={rel} className="context-chip">
                <FileText size={11} aria-hidden="true" />
                <span>@{rel}</span>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Remove ${rel}`}
                  onClick={() => onRemoveAttachment(rel)}
                >
                  <X size={10} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="composer-textarea"
          data-testid="composer-textarea"
          placeholder="Message session or type @ to attach project artifacts, docs, or memories... (Enter to send)"
          value={composerText}
          onChange={(ev) => {
            const next = ev.target.value
            onComposerTextChange(next)

            if (next.endsWith("@")) {
              setShowAtPicker(true)
            }
          }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" && !ev.shiftKey) {
              ev.preventDefault()
              onSend()
            }
          }}
        />

        <div className="composer-footer">
          <div className="composer-left-tools">
            <button
              type="button"
              className="btn-ghost btn-xs"
              data-testid="composer-at-btn"
              onClick={() => setShowAtPicker((v) => !v)}
            >
              <AtSign size={12} aria-hidden="true" />
              Context
            </button>

            <select
              className="target-select"
              data-testid="composer-target-select"
              aria-label="Target session"
              value={targetSessionId ?? ""}
              onChange={(ev) => onTargetSessionChange(ev.target.value)}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.isEntry ? `Entry · ${s.name}` : `${s.name} (${s.git?.branch || s.harness})`}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="btn-primary btn-xs"
            data-testid="composer-send-btn"
            disabled={sending || composerText.trim().length === 0 || !targetSessionId}
            onClick={onSend}
          >
            <Send size={12} aria-hidden="true" />
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </section>
  )
}
