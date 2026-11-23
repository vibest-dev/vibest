import { Copy } from "lucide-react"
import { useEffect, useState } from "react"

import type { SessionRecord, SessionStatus, Task } from "../schema.ts"
import { hubApi } from "./api.ts"
import { SessionStatusText } from "./labels.tsx"

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
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Sessions</h1>
            <p className="page-lede">
              Harness sessions by workstream, and the session facts block every prompt carries through compaction.
            </p>
          </div>
        </header>

        <section className="section" aria-labelledby="sessions-table-title">
          <div className="section-head">
            <h2 className="section-title" id="sessions-table-title">
              Registered sessions
              <span className="section-count">{sessions.length}</span>
            </h2>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Harness</th>
                <th scope="col">Workstream</th>
                <th scope="col">Directory</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} data-testid={`session-row-${s.id}`}>
                  <td>
                    <div className="session-name">{s.name}</div>
                    <div className="session-id mono">{s.id}</div>
                    {s.blockedReason && <div className="session-reason">{s.blockedReason}</div>}
                  </td>
                  <td>
                    <div>{s.harness}</div>
                    {s.model && <div className="session-id mono">{s.model}</div>}
                  </td>
                  <td>{s.taskId ? (taskTitleById.get(s.taskId) ?? s.taskId) : "Unassigned"}</td>
                  <td>
                    <span className="session-dir mono">{s.directory}</span>
                  </td>
                  <td>
                    <div className="btn-row">
                      <SessionStatusText status={s.status} />
                      <select
                        className="select status-select"
                        aria-label={`Status of ${s.name}`}
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="facts" aria-labelledby="sessions-facts-title">
          <div className="facts-head">
            <h2 className="facts-title" id="sessions-facts-title">
              Session facts block
            </h2>
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
              <Copy size={12} aria-hidden="true" /> {copied ? "Copied" : "Copy block"}
            </button>
          </div>
          <pre className="code-block" data-testid="sessions-facts-markdown">
            {factsMarkdown}
          </pre>
        </section>
      </div>
    </div>
  )
}
