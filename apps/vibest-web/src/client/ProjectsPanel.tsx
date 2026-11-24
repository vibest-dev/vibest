import { Cpu, FolderGit2, Moon, Search, Server, Sun } from "lucide-react"
import { useMemo, useState } from "react"

import type { DaemonStatus, ProjectSummary, ThemeMode } from "../types.ts"

function shortenHomePath(dir: string): string {
  return dir.replace(/^\/Users\/[^/]+/, "~").replace(/^\/Volumes\/SSD\/GitHub\//, "SSD/GitHub/")
}

function formatLoadLabel(daemon: DaemonStatus): string {
  if (!daemon.load) return daemon.connected ? "vibestd online" : "vibestd offline"

  const cpuText =
    daemon.load.cpuUtilization !== null
      ? `${Math.round(daemon.load.cpuUtilization * 100)}% CPU`
      : `${daemon.load.cpuCount}c`

  const usedGb = Math.max(0, daemon.load.memoryTotalBytes - daemon.load.memoryAvailableBytes) / 1024 ** 3
  const totalGb = Math.max(1, daemon.load.memoryTotalBytes) / 1024 ** 3

  return `${cpuText} · ${usedGb.toFixed(1)}/${totalGb.toFixed(0)}G`
}

function activityTone(activity: ProjectSummary["activity"]): string {
  switch (activity) {
    case "blocked":
      return "is-needs-you"
    case "working":
      return "is-working"
    case "done":
      return "is-done"
    case "idle":
      return "is-idle"
  }
}

export function ProjectsPanel(props: {
  readonly projects: ReadonlyArray<ProjectSummary>
  readonly selectedProjectId: string | null
  readonly daemon: DaemonStatus
  readonly theme: ThemeMode
  readonly onSelectProject: (projectId: string) => void
  readonly onToggleTheme: () => void
}) {
  const { projects, selectedProjectId, daemon, theme, onSelectProject, onToggleTheme } = props
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()

    if (q.length === 0) return projects

    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.directory.toLowerCase().includes(q) ||
        p.machine.toLowerCase().includes(q),
    )
  }, [projects, query])

  return (
    <aside className="panel panel-projects" data-testid="projects-panel">
      <header className="panel-header">
        <div className="panel-title-group">
          <FolderGit2 size={14} className="panel-icon" aria-hidden="true" />
          <span className="panel-title">Projects</span>
          <span className="count-pill">{projects.length}</span>
        </div>
        <button
          type="button"
          className="icon-btn"
          data-testid="theme-toggle-btn"
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
        </button>
      </header>

      <div className="projects-controls">
        <div className="search-input-wrap">
          <Search size={13} className="search-icon" aria-hidden="true" />
          <input
            type="text"
            className="search-input"
            data-testid="project-filter-input"
            placeholder="Filter projects..."
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
          />
        </div>

        <div
          className={`daemon-pill ${daemon.connected ? "is-online" : "is-offline"}`}
          data-testid="daemon-status-pill"
          title={daemon.socket}
        >
          <span className="status-dot" />
          <span className="daemon-label">vibestd</span>
          <span className="daemon-sep">·</span>
          <Cpu size={11} aria-hidden="true" />
          <span className="tabular-nums">{formatLoadLabel(daemon)}</span>
        </div>
      </div>

      <div className="panel-scroll projects-list" role="list">
        {filtered.map((project) => {
          const active = project.id === selectedProjectId

          return (
            <button
              key={project.id}
              type="button"
              role="listitem"
              data-testid={`project-item-${project.name}`}
              className={`project-card ${active ? "is-selected" : ""}`}
              onClick={() => onSelectProject(project.id)}
            >
              <div className="project-card-top">
                <span className={`status-dot ${activityTone(project.activity)}`} />
                <span className="project-name">{project.name}</span>
                {project.needsYouCount > 0 ? (
                  <span className="badge badge-amber tabular-nums">Needs You · {project.needsYouCount}</span>
                ) : project.activeSubagents > 0 ? (
                  <span className="badge badge-blue tabular-nums">{project.activeSubagents} active</span>
                ) : null}
              </div>

              <div className="project-path" title={project.directory}>
                {shortenHomePath(project.directory)}
              </div>

              <div className="project-meta">
                <span className="meta-chip">
                  <Server size={10} aria-hidden="true" />
                  {project.machine}
                </span>
                <span className="meta-chip meta-branch">{project.branch}</span>
              </div>
            </button>
          )
        })}

        {filtered.length === 0 && <div className="empty-state">No projects match "{query}".</div>}
      </div>
    </aside>
  )
}
