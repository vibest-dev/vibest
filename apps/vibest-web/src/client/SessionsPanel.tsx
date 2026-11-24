import {
  Archive,
  ChevronDown,
  ChevronRight,
  CloudUpload,
  GitBranch,
  Layers,
  Send,
  Square,
  Terminal,
} from "lucide-react"
import { useMemo, useState } from "react"

import type { SessionFilter, SessionItem, ThemeMode } from "../types.ts"
import { WtermView } from "./WtermView.tsx"

function formatElapsed(createdAt: number, lastActive: number): string {
  const diffSec = Math.max(1, Math.floor((Date.now() - Math.min(createdAt, lastActive)) / 1000))

  if (diffSec < 60) return `${diffSec}s`
  const mins = Math.floor(diffSec / 60)

  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)

  return `${hrs}h ${mins % 60}m`
}

function statusDotClass(session: SessionItem): string {
  if (session.needsYou) return "is-needs-you"

  if (session.status === "working") return "is-working"

  if (session.status === "done") return "is-done"

  return "is-idle"
}

function statusLabel(session: SessionItem): string {
  if (session.needsYou) return "Needs You"

  if (session.status === "working") return "Working"

  if (session.status === "done") return "Done"

  return "Idle"
}

export function SessionsPanel(props: {
  readonly sessions: ReadonlyArray<SessionItem>
  readonly theme: ThemeMode
  readonly expandedPeekId: string | null
  readonly peekCache: Readonly<Record<string, string>>
  readonly onTogglePeek: (sessionId: string) => void
  readonly onRefreshPeek: (sessionId: string) => void
  readonly onOpenTerminalStage: (sessionId: string) => void
  readonly onSelectForSend: (sessionId: string) => void
  readonly onInterrupt: (sessionId: string) => void
  readonly onArchive: (sessionId: string) => void
}) {
  const {
    sessions,
    theme,
    expandedPeekId,
    peekCache,
    onTogglePeek,
    onRefreshPeek,
    onOpenTerminalStage,
    onSelectForSend,
    onInterrupt,
    onArchive,
  } = props

  const [filter, setFilter] = useState<SessionFilter>("all")

  const branchSessions = useMemo(() => sessions.filter((s) => !s.isEntry), [sessions])

  const counts = useMemo(() => {
    let needsYou = 0
    let working = 0
    let done = 0

    for (const s of branchSessions) {
      if (s.needsYou) needsYou += 1
      else if (s.status === "working") working += 1
      else done += 1
    }

    return { all: branchSessions.length, needsYou, working, done }
  }, [branchSessions])

  const filtered = useMemo(() => {
    if (filter === "all") return branchSessions

    if (filter === "needs_you") return branchSessions.filter((s) => s.needsYou)

    if (filter === "working") return branchSessions.filter((s) => !s.needsYou && s.status === "working")

    return branchSessions.filter((s) => !s.needsYou && s.status !== "working")
  }, [branchSessions, filter])

  return (
    <section className="panel panel-sessions" data-testid="sessions-panel">
      <header className="panel-header">
        <div className="panel-title-group">
          <Layers size={14} className="panel-icon" aria-hidden="true" />
          <span className="panel-title">Sessions</span>
          <span className="count-pill tabular-nums">{counts.all}</span>
        </div>
        <span className="live-indicator" title="Live via vibestd Watch SSE">
          <span className="status-dot is-working" />
          Watch
        </span>
      </header>

      <div className="filter-bar" role="tablist" aria-label="Filter branch sessions">
        <button
          type="button"
          className={`filter-pill ${filter === "all" ? "is-active" : ""}`}
          data-testid="sessions-filter-all"
          onClick={() => setFilter("all")}
        >
          All <span className="tabular-nums">{counts.all}</span>
        </button>
        <button
          type="button"
          className={`filter-pill ${filter === "needs_you" ? "is-active" : ""}`}
          data-testid="sessions-filter-needs-you"
          onClick={() => setFilter("needs_you")}
        >
          Needs You <span className="tabular-nums">{counts.needsYou}</span>
        </button>
        <button
          type="button"
          className={`filter-pill ${filter === "working" ? "is-active" : ""}`}
          data-testid="sessions-filter-working"
          onClick={() => setFilter("working")}
        >
          Working <span className="tabular-nums">{counts.working}</span>
        </button>
        <button
          type="button"
          className={`filter-pill ${filter === "done" ? "is-active" : ""}`}
          data-testid="sessions-filter-done"
          onClick={() => setFilter("done")}
        >
          Done <span className="tabular-nums">{counts.done}</span>
        </button>
      </div>

      <div className="panel-scroll sessions-list">
        {filtered.map((session) => {
          const isExpanded = expandedPeekId === session.id

          return (
            <div
              key={session.id}
              className={`session-card ${isExpanded ? "is-expanded" : ""}`}
              data-testid={`session-card-${session.id.slice(0, 8)}`}
            >
              <button
                type="button"
                className="session-card-main"
                onClick={() => onTogglePeek(session.id)}
                aria-expanded={isExpanded}
              >
                <div className="session-card-top">
                  {isExpanded ? (
                    <ChevronDown size={13} className="session-chevron" aria-hidden="true" />
                  ) : (
                    <ChevronRight size={13} className="session-chevron" aria-hidden="true" />
                  )}
                  <span className={`status-dot ${statusDotClass(session)}`} />
                  <span className="session-title">{session.name}</span>
                  <span className="session-elapsed tabular-nums">
                    {formatElapsed(session.createdAt, session.lastActive)}
                  </span>
                </div>

                <div className="session-badges">
                  <span
                    className={`badge ${session.needsYou ? "badge-amber" : session.status === "working" ? "badge-blue" : "badge-muted"}`}
                  >
                    {statusLabel(session)}
                  </span>
                  {session.git?.branch ? (
                    <span className="meta-chip meta-branch">
                      <GitBranch size={10} aria-hidden="true" />
                      {session.git.branch}
                    </span>
                  ) : null}
                  {session.git?.pushed ? (
                    <span className="meta-chip meta-pushed">
                      <CloudUpload size={10} aria-hidden="true" />
                      pushed
                    </span>
                  ) : session.git?.saved ? (
                    <span className="meta-chip">saved</span>
                  ) : null}
                  <span className="meta-chip">
                    {session.harness}
                    {session.model ? `/${session.model}` : ""}
                  </span>
                </div>

                {session.summary.length > 0 && <div className="session-summary">{session.summary}</div>}
              </button>

              <div className="session-actions">
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  data-testid={`session-peek-btn-${session.id.slice(0, 8)}`}
                  onClick={() => onTogglePeek(session.id)}
                >
                  <Terminal size={11} aria-hidden="true" />
                  Peek
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  data-testid={`session-send-btn-${session.id.slice(0, 8)}`}
                  onClick={() => onSelectForSend(session.id)}
                >
                  <Send size={11} aria-hidden="true" />
                  Send
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  data-testid={`session-interrupt-btn-${session.id.slice(0, 8)}`}
                  onClick={() => onInterrupt(session.id)}
                >
                  <Square size={10} aria-hidden="true" />
                  Interrupt
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-xs is-danger"
                  data-testid={`session-archive-btn-${session.id.slice(0, 8)}`}
                  onClick={() => onArchive(session.id)}
                >
                  <Archive size={11} aria-hidden="true" />
                  Archive
                </button>
              </div>

              {isExpanded && (
                <div className="session-inline-peek">
                  <WtermView
                    content={peekCache[session.id] ?? "Connecting to terminal stream..."}
                    theme={theme}
                    compact
                    title={`@wterm/dom · ${session.git?.branch || session.name}`}
                    onRefresh={() => onRefreshPeek(session.id)}
                    onExpand={() => onOpenTerminalStage(session.id)}
                  />
                </div>
              )}
            </div>
          )
        })}

        {filtered.length === 0 && <div className="empty-state">No branch sessions in this filter.</div>}
      </div>
    </section>
  )
}
