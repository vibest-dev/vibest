import { Copy, Terminal } from "lucide-react"
import { useEffect, useState } from "react"

import type { SessionRecord, SessionStatus, Task } from "../schema.ts"

const SESSION_BADGE_MAP: Record<SessionStatus, string> = {
  running: "badge-green",
  blocked: "badge-red",
  idle: "badge-neutral",
  ended: "badge-neutral",
}

import { hubApi } from "./api.ts"

export function SessionsView(props: { projectId: string; refreshSignal: number; onMutated: () => Promise<void> }) {
  const { projectId, refreshSignal, onMutated } = props
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [factsMarkdown, setFactsMarkdown] = useState("")
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void hubApi.getSessionsView(projectId).then((res) => {
      setSessions(res.sessions)
      setTasks(res.tasks)
      setFactsMarkdown(res.sessionFactsMarkdown)
    })
  }, [projectId, refreshSignal])

  const taskTitleById = new Map<string, string>()

  for (const t of tasks) {
    taskTitleById.set(t.id, t.title)
  }

  const handleStatusChange = async (sessionId: string, nextStatus: SessionStatus) => {
    const reason = nextStatus === "blocked" ? "Paused by user for manual review check" : undefined

    await hubApi.updateSessionStatus(sessionId, nextStatus, reason)
    await onMutated()
    const refreshed = await hubApi.getSessionsView(projectId)
    setSessions(refreshed.sessions)
    setFactsMarkdown(refreshed.sessionFactsMarkdown)
  }

  return (
    <div className="page-scroll" data-testid="sessions-view">
      <div className="page-header">
        <div>
          <h1 className="page-title">Sessions &amp; Prompt Snapshot</h1>
          <p className="page-subtitle">
            Live harness sessions grouped by Task + compaction-proof Session Facts markdown block
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 22 }}>
        <div className="drawer-section-title">
          <span>
            <Terminal size={13} style={{ verticalAlign: "middle", marginRight: 6 }} />
            Compaction-Proof Session Facts Block
          </span>
          <button
            type="button"
            data-testid="copy-session-facts-btn"
            className="btn btn-sm"
            onClick={() => {
              void navigator.clipboard?.writeText(factsMarkdown)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            <Copy size={12} /> {copied ? "Copied!" : "Copy Block"}
          </button>
        </div>
        <pre className="code-block" data-testid="sessions-facts-markdown" style={{ margin: 0 }}>
          {factsMarkdown}
        </pre>
      </div>

      <div className="card">
        <div className="drawer-section-title">
          <span>Registered Project Sessions ({sessions.length})</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sessions.map((s) => (
            <div
              key={s.id}
              data-testid={`session-row-${s.id}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 14px",
                borderRadius: 8,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-subtle)",
                gap: 14,
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <div className="btn-row">
                  <strong style={{ fontSize: 14 }}>{s.name}</strong>
                  <code>{s.id}</code>
                  <span className="badge badge-blue">{s.harness}</span>
                  {s.model && <span className="badge badge-neutral">{s.model}</span>}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  Workstream: {s.taskId ? (taskTitleById.get(s.taskId) ?? s.taskId) : "Unassigned"} · Dir:{" "}
                  <code>{s.directory}</code>
                </div>
                {s.blockedReason && (
                  <div style={{ fontSize: 12, color: "var(--accent-red)" }}>Blocked: {s.blockedReason}</div>
                )}
              </div>

              <div className="btn-row">
                <span className={`badge ${SESSION_BADGE_MAP[s.status]}`}>{s.status}</span>
                <select
                  className="input"
                  style={{ width: 120, padding: "4px 8px" }}
                  value={s.status}
                  onChange={(ev) => {
                    const val = ev.target.value

                    if (val === "running" || val === "idle" || val === "blocked" || val === "ended") {
                      void handleStatusChange(s.id, val)
                    }
                  }}
                >
                  <option value="running">running</option>
                  <option value="idle">idle</option>
                  <option value="blocked">blocked</option>
                  <option value="ended">ended</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
