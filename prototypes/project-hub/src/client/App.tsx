import { BookOpen, FolderPlus, Kanban, Layers, Moon, Sun, TerminalSquare } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import type { BoardViewData } from "../schema.ts"
import { formatWorkspaceHash, parseWorkspaceHash, type NavTab } from "../workspace-hash.ts"
import { hubApi, type ArtifactWithCount, type ProjectSummary } from "./api.ts"
import { ArtifactStudio } from "./ArtifactStudio.tsx"
import { ArtifactsGalleryView, BoardView } from "./BoardView.tsx"
import { KnowledgeView } from "./KnowledgeView.tsx"
import { AddProjectModal, NewArtifactModal, NewTaskModal } from "./Modals.tsx"
import { SessionsView } from "./SessionsView.tsx"

export function App() {
  const initialRoute = parseWorkspaceHash(window.location.hash)
  const [theme, setTheme] = useState<"dark" | "light">("dark")
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [detectedVibestDir, setDetectedVibestDir] = useState<string | null>(null)
  const [activeProjectId, setActiveProjectId] = useState<string>(() => initialRoute.projectId ?? "")
  const activeProjectIdRef = useRef<string>(initialRoute.projectId ?? "")
  const [activeTab, setActiveTab] = useState<NavTab>(() => initialRoute.tab)
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(() => initialRoute.artifactId)

  const [board, setBoard] = useState<BoardViewData | null>(null)
  const [artifacts, setArtifacts] = useState<ArtifactWithCount[]>([])
  const [wsConnected, setWsConnected] = useState(false)
  const [refreshSignal, setRefreshSignal] = useState(0)

  const [showAddProject, setShowAddProject] = useState(false)
  const [showNewTask, setShowNewTask] = useState(false)
  const [showNewArtifact, setShowNewArtifact] = useState(false)

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme)
  }, [theme])

  const loadProjectsAndWorkspace = useCallback(async (preferredProjectId?: string) => {
    const res = await hubApi.listProjects()
    setProjects(res.projects)
    setDetectedVibestDir(res.detectedVibestProjectDir)

    const currentActive = activeProjectIdRef.current

    const targetId =
      preferredProjectId ??
      (currentActive && res.projects.some((p) => p.id === currentActive) ? currentActive : res.projects[0]?.id)

    if (targetId) {
      activeProjectIdRef.current = targetId
      setActiveProjectId(targetId)

      const [boardData, artData] = await Promise.all([hubApi.getBoard(targetId), hubApi.listArtifacts(targetId)])

      setBoard(boardData)
      setArtifacts(artData.artifacts)
    }
  }, [])

  useEffect(() => {
    void loadProjectsAndWorkspace()
  }, [loadProjectsAndWorkspace])

  useEffect(() => {
    if (!activeProjectId) return
    const nextHash = formatWorkspaceHash(activeProjectId, activeTab, openArtifactId)

    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash)
    }
  }, [activeProjectId, activeTab, openArtifactId])

  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseWorkspaceHash(window.location.hash)
      setActiveTab(parsed.tab)
      setOpenArtifactId(parsed.artifactId)

      if (parsed.projectId && parsed.projectId !== activeProjectIdRef.current) {
        activeProjectIdRef.current = parsed.projectId
        setActiveProjectId(parsed.projectId)
        void loadProjectsAndWorkspace(parsed.projectId)
      }
    }

    window.addEventListener("hashchange", onHashChange)

    return () => window.removeEventListener("hashchange", onHashChange)
  }, [loadProjectsAndWorkspace])

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)

    ws.onopen = () => setWsConnected(true)
    ws.onclose = () => setWsConnected(false)
    ws.onmessage = () => {
      setRefreshSignal((n) => n + 1)
      void loadProjectsAndWorkspace()
    }

    return () => {
      ws.close()
    }
  }, [loadProjectsAndWorkspace])

  const needsYouCount = board?.needsYou.length ?? 0

  return (
    <div className="app-shell">
      <aside className="left-rail">
        <div className="rail-brand">
          <div className="rail-brand-title">
            <span className="live-dot" style={{ opacity: wsConnected ? 1 : 0.35 }} />
            <span>Vibest Hub</span>
          </div>
          <button
            type="button"
            data-testid="theme-toggle-btn"
            className="btn btn-sm"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title="Toggle Dark / Light Theme"
          >
            {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
          </button>
        </div>

        <div className="project-switcher-box">
          <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>
            Project Workspace
          </label>
          <select
            data-testid="project-switcher-select"
            className="project-select"
            value={activeProjectId}
            onChange={(ev) => {
              const nextId = ev.target.value
              setOpenArtifactId(null)
              setActiveProjectId(nextId)
              void loadProjectsAndWorkspace(nextId)
            }}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.needsYouCount} Needs You)
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="open-add-project-btn"
            className="btn btn-sm"
            style={{ width: "100%" }}
            onClick={() => setShowAddProject(true)}
          >
            <FolderPlus size={13} /> + Add / Import Vibest
          </button>
        </div>

        <nav className="rail-nav" aria-label="Workspace Navigation">
          <button
            type="button"
            data-testid="nav-board"
            className={`rail-nav-btn ${activeTab === "board" && !openArtifactId ? "active" : ""}`}
            onClick={() => {
              setOpenArtifactId(null)
              setActiveTab("board")
            }}
          >
            <span className="rail-nav-left">
              <Kanban size={15} /> Board
            </span>
            {needsYouCount > 0 && (
              <span className="badge badge-urgent" data-testid="rail-needs-you-badge">
                {needsYouCount}
              </span>
            )}
          </button>

          <button
            type="button"
            data-testid="nav-artifacts"
            className={`rail-nav-btn ${activeTab === "artifacts" || openArtifactId ? "active" : ""}`}
            onClick={() => {
              setOpenArtifactId(null)
              setActiveTab("artifacts")
            }}
          >
            <span className="rail-nav-left">
              <Layers size={15} /> Artifacts Studio
            </span>
            <span className="badge badge-neutral">{artifacts.length}</span>
          </button>

          <button
            type="button"
            data-testid="nav-sessions"
            className={`rail-nav-btn ${activeTab === "sessions" && !openArtifactId ? "active" : ""}`}
            onClick={() => {
              setOpenArtifactId(null)
              setActiveTab("sessions")
            }}
          >
            <span className="rail-nav-left">
              <TerminalSquare size={15} /> Sessions &amp; Facts
            </span>
          </button>

          <button
            type="button"
            data-testid="nav-knowledge"
            className={`rail-nav-btn ${activeTab === "knowledge" && !openArtifactId ? "active" : ""}`}
            onClick={() => {
              setOpenArtifactId(null)
              setActiveTab("knowledge")
            }}
          >
            <span className="rail-nav-left">
              <BookOpen size={15} /> Project Knowledge
            </span>
          </button>
        </nav>

        <div
          style={{
            marginTop: "auto",
            padding: "10px",
            borderRadius: 8,
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            fontSize: 11.5,
            color: "var(--text-secondary)",
          }}
        >
          <div style={{ fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>Interactive Surfaces</div>
          <div>• HTML: 点选元素 + 框选/圈选</div>
          <div>• Excalidraw: 画图 + 节点评论</div>
          <div>• Spec: 划词引用 + 决策单多选</div>
        </div>
      </aside>

      <main className="main-workspace">
        {openArtifactId ? (
          <ArtifactStudio
            artifactId={openArtifactId}
            refreshSignal={refreshSignal}
            onBack={() => setOpenArtifactId(null)}
            onReviewSubmitted={() => void loadProjectsAndWorkspace()}
          />
        ) : activeTab === "board" && board ? (
          <BoardView
            board={board}
            onOpenArtifact={(id) => setOpenArtifactId(id)}
            onOpenNewTaskModal={() => setShowNewTask(true)}
            onOpenNewArtifactModal={() => setShowNewArtifact(true)}
            onBoardMutated={() => loadProjectsAndWorkspace()}
          />
        ) : activeTab === "artifacts" ? (
          <ArtifactsGalleryView
            artifacts={artifacts}
            onOpenArtifact={(id) => setOpenArtifactId(id)}
            onOpenNewArtifactModal={() => setShowNewArtifact(true)}
          />
        ) : activeTab === "sessions" && activeProjectId ? (
          <SessionsView
            projectId={activeProjectId}
            refreshSignal={refreshSignal}
            onMutated={() => loadProjectsAndWorkspace()}
          />
        ) : activeTab === "knowledge" && activeProjectId ? (
          <KnowledgeView projectId={activeProjectId} refreshSignal={refreshSignal} />
        ) : (
          <div className="page-scroll">Loading workspace...</div>
        )}
      </main>

      {showAddProject && (
        <AddProjectModal
          detectedVibestDir={detectedVibestDir}
          onClose={() => setShowAddProject(false)}
          onCreated={(proj) => {
            activeProjectIdRef.current = proj.id
            setActiveProjectId(proj.id)
            setShowAddProject(false)
            setOpenArtifactId(null)
            setActiveTab("board")
            void loadProjectsAndWorkspace(proj.id)
          }}
        />
      )}

      {showNewTask && activeProjectId && (
        <NewTaskModal
          projectId={activeProjectId}
          onClose={() => setShowNewTask(false)}
          onCreated={() => {
            setShowNewTask(false)
            void loadProjectsAndWorkspace()
          }}
        />
      )}

      {showNewArtifact && activeProjectId && (
        <NewArtifactModal
          projectId={activeProjectId}
          tasks={board?.inProgress.map((l) => l.task) ?? []}
          onClose={() => setShowNewArtifact(false)}
          onCreated={(artId) => {
            setShowNewArtifact(false)
            void loadProjectsAndWorkspace().then(() => setOpenArtifactId(artId))
          }}
        />
      )}
    </div>
  )
}
