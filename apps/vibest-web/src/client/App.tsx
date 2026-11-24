import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type {
  DaemonStatus,
  ProjectFileEntry,
  ProjectSummary,
  SessionItem,
  StageItem,
  StageMode,
  ThemeMode,
  TimelineEntry,
  WorkspaceSnapshot,
} from "../types.ts"
import { webApi } from "./api.ts"
import { ChatPanel } from "./ChatPanel.tsx"
import { TooltipProvider } from "./components/ui/tooltip.tsx"
import { KnowledgePanel } from "./KnowledgePanel.tsx"
import { cn } from "./lib/utils.ts"
import { ProjectsPanel } from "./ProjectsPanel.tsx"
import { SessionsPanel } from "./SessionsPanel.tsx"
import { StagePanel } from "./StagePanel.tsx"

const INITIAL_DAEMON: DaemonStatus = {
  connected: false,
  mode: "isolated",
  version: "0.0.2-dev",
  socket: "",
  load: null,
}

export function App() {
  const [theme, setTheme] = useState<ThemeMode>("dark")
  const [daemon, setDaemon] = useState<DaemonStatus>(INITIAL_DAEMON)
  const [projects, setProjects] = useState<ReadonlyArray<ProjectSummary>>([])
  const [sessions, setSessions] = useState<ReadonlyArray<SessionItem>>([])
  const [filesByProject, setFilesByProject] = useState<Readonly<Record<string, ReadonlyArray<ProjectFileEntry>>>>({})

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<ReadonlyArray<TimelineEntry>>([])

  const [stageMode, setStageMode] = useState<StageMode>("chat")
  const [stageItem, setStageItem] = useState<StageItem | null>(null)
  const [expandedPeekId, setExpandedPeekId] = useState<string | null>(null)
  const [peekCache, setPeekCache] = useState<Readonly<Record<string, string>>>({})

  const [composerText, setComposerText] = useState("")
  const [attachedPaths, setAttachedPaths] = useState<ReadonlyArray<string>>([])
  const [sending, setSending] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const [leftWidth, setLeftWidth] = useState(264)
  const [rightWidth, setRightWidth] = useState(408)
  const [rightSplitPercent, setRightSplitPercent] = useState(52)
  const [draggingSplit, setDraggingSplit] = useState(false)

  const rightColumnRef = useRef<HTMLDivElement | null>(null)
  const activeSessionIdRef = useRef<string | null>(activeSessionId)
  activeSessionIdRef.current = activeSessionId

  useEffect(() => {
    const root = document.documentElement

    if (theme === "dark") {
      root.classList.add("dark")
    } else {
      root.classList.remove("dark")
    }
  }, [theme])

  const showToast = useCallback((message: string) => {
    setToast(message)
    setTimeout(() => {
      setToast((prev) => (prev === message ? null : prev))
    }, 2800)
  }, [])

  const applySnapshot = useCallback((snap: WorkspaceSnapshot) => {
    setDaemon(snap.daemon)
    setProjects(snap.projects)
    setSessions(snap.sessions)
    setFilesByProject(snap.filesByProject)
    setSelectedProjectId((prev) => {
      if (prev && snap.projects.some((p) => p.id === prev)) return prev

      return snap.projects[0]?.id ?? null
    })
  }, [])

  useEffect(() => {
    void webApi
      .getState()
      .then(applySnapshot)
      .catch(() => {})

    const source = new EventSource("/api/stream")

    source.addEventListener("snapshot", (ev: MessageEvent) => {
      try {
        applySnapshot(JSON.parse(String(ev.data)))
      } catch {
        return
      }
    })

    source.addEventListener("daemon", (ev: MessageEvent) => {
      try {
        setDaemon(JSON.parse(String(ev.data)))
      } catch {
        return
      }
    })

    source.addEventListener("project", (ev: MessageEvent) => {
      try {
        const updated: ProjectSummary = JSON.parse(String(ev.data))
        setProjects((prev) => {
          const exists = prev.some((p) => p.id === updated.id)

          return exists ? prev.map((p) => (p.id === updated.id ? updated : p)) : [...prev, updated]
        })
      } catch {
        return
      }
    })

    source.addEventListener("session", (ev: MessageEvent) => {
      try {
        const updated: SessionItem = JSON.parse(String(ev.data))
        setSessions((prev) => {
          const exists = prev.some((s) => s.id === updated.id)

          return exists ? prev.map((s) => (s.id === updated.id ? updated : s)) : [updated, ...prev]
        })
      } catch {
        return
      }
    })

    source.addEventListener("session-ended", (ev: MessageEvent) => {
      try {
        const removed: { readonly id: string } = JSON.parse(String(ev.data))
        setSessions((prev) => prev.filter((s) => s.id !== removed.id))
      } catch {
        return
      }
    })

    source.addEventListener("files-changed", (ev: MessageEvent) => {
      try {
        const payload: { readonly projectId: string; readonly files: ReadonlyArray<ProjectFileEntry> } = JSON.parse(
          String(ev.data),
        )

        setFilesByProject((prev) => ({ ...prev, [payload.projectId]: payload.files }))
      } catch {
        return
      }
    })

    source.addEventListener("timeline-entry", (ev: MessageEvent) => {
      try {
        const entry: TimelineEntry = JSON.parse(String(ev.data))

        if (entry.sessionId !== activeSessionIdRef.current) return
        setTimeline((prev) => (prev.some((t) => t.id === entry.id) ? prev : [...prev, entry]))
      } catch {
        return
      }
    })

    return () => {
      source.close()
    }
  }, [applySnapshot])

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  )

  const projectSessions = useMemo(
    () => sessions.filter((s) => s.projectId === selectedProjectId),
    [sessions, selectedProjectId],
  )

  const projectFiles = useMemo(
    () => (selectedProjectId ? (filesByProject[selectedProjectId] ?? []) : []),
    [filesByProject, selectedProjectId],
  )

  useEffect(() => {
    if (!selectedProject) {
      setActiveSessionId(null)
      setTargetSessionId(null)

      return
    }

    const entryId =
      selectedProject.entrySessionId ?? projectSessions.find((s) => s.isEntry)?.id ?? projectSessions[0]?.id ?? null

    setActiveSessionId((prev) => (prev && projectSessions.some((s) => s.id === prev) ? prev : entryId))
    setTargetSessionId((prev) => (prev && projectSessions.some((s) => s.id === prev) ? prev : entryId))
  }, [selectedProject, projectSessions])

  useEffect(() => {
    if (!selectedProjectId || !activeSessionId) {
      setTimeline([])

      return
    }

    let cancelled = false
    void webApi
      .getTimeline(selectedProjectId, activeSessionId)
      .then((res) => {
        if (!cancelled) setTimeline(res.entries)
      })
      .catch(() => {
        if (!cancelled) setTimeline([])
      })

    return () => {
      cancelled = true
    }
  }, [selectedProjectId, activeSessionId])

  const fetchPeek = useCallback(async (sessionId: string) => {
    try {
      const res = await webApi.peekSession(sessionId)
      setPeekCache((prev) => ({ ...prev, [sessionId]: res.terminal || res.text }))
    } catch {
      return
    }
  }, [])

  const handleTogglePeek = useCallback(
    (sessionId: string) => {
      setExpandedPeekId((prev) => {
        const next = prev === sessionId ? null : sessionId

        if (next) {
          void fetchPeek(next)
        }

        return next
      })
    },
    [fetchPeek],
  )

  const handleOpenTerminalStage = useCallback(
    (sessionId: string) => {
      void fetchPeek(sessionId)
      setStageItem({ kind: "terminal", sessionId })
      setStageMode((prev) => (prev === "chat" ? "split" : prev))
    },
    [fetchPeek],
  )

  const handleOpenFile = useCallback((file: ProjectFileEntry) => {
    setStageItem({ kind: "file", file })
    setStageMode((prev) => (prev === "chat" ? "split" : prev))
  }, [])

  const handleAddAttachment = useCallback((relativePath: string) => {
    setAttachedPaths((prev) => (prev.includes(relativePath) ? prev : [...prev, relativePath]))
  }, [])

  const handleAddToComposer = useCallback(
    (text: string, attachmentPath?: string) => {
      setComposerText((prev) => (prev.trim().length > 0 ? `${prev.trim()}\n\n${text}` : text))

      if (attachmentPath) {
        handleAddAttachment(attachmentPath)
      }

      if (stageMode === "stage") {
        setStageMode("split")
      }

      showToast("Added structured feedback to Composer")
    },
    [handleAddAttachment, stageMode, showToast],
  )

  const handleSend = useCallback(async () => {
    if (!targetSessionId || composerText.trim().length === 0 || sending) return
    setSending(true)

    try {
      const res = await webApi.sendToSession(targetSessionId, composerText, attachedPaths)

      if (res.ok) {
        setComposerText("")
        setAttachedPaths([])
        showToast("Dispatched message via vibestd")
      } else {
        showToast(res.error ?? "Failed to send")
      }
    } finally {
      setSending(false)
    }
  }, [targetSessionId, composerText, attachedPaths, sending, showToast])

  const handleInterrupt = useCallback(
    async (sessionId: string) => {
      const res = await webApi.interruptSession(sessionId)
      showToast(res.message)
    },
    [showToast],
  )

  const handleArchive = useCallback(
    async (sessionId: string) => {
      const res = await webApi.archiveSession(sessionId)

      if (expandedPeekId === sessionId) setExpandedPeekId(null)
      showToast(res.message)
    },
    [expandedPeekId, showToast],
  )

  const startHorizontalDrag = (side: "left" | "right", startX: number) => {
    const startWidth = side === "left" ? leftWidth : rightWidth
    setDraggingSplit(true)

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX

      if (side === "left") {
        setLeftWidth(Math.min(340, Math.max(210, startWidth + delta)))
      } else {
        setRightWidth(Math.min(540, Math.max(320, startWidth - delta)))
      }
    }

    const onUp = () => {
      setDraggingSplit(false)
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }

    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  const startRightVerticalDrag = (startY: number) => {
    const container = rightColumnRef.current

    if (!container) return
    const totalHeight = container.clientHeight || 1
    const startPct = rightSplitPercent
    setDraggingSplit(true)

    const onMove = (ev: MouseEvent) => {
      const deltaPct = ((ev.clientY - startY) / totalHeight) * 100
      setRightSplitPercent(Math.min(76, Math.max(26, startPct + deltaPct)))
    }

    const onUp = () => {
      setDraggingSplit(false)
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }

    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  const activeStageFileId = stageItem?.kind === "file" ? stageItem.file.id : null

  const activeStagePeekText =
    stageItem?.kind === "terminal" ? (peekCache[stageItem.sessionId] ?? "Loading terminal...") : ""

  return (
    <TooltipProvider>
      <div
        className={cn(
          "flex h-dvh w-full overflow-hidden bg-sidebar p-2 text-foreground select-none",
          draggingSplit && "[&_iframe]:pointer-events-none",
        )}
        data-testid="workspace-canvas"
      >
        <aside className="flex h-full shrink-0 flex-col" style={{ width: leftWidth }}>
          <ProjectsPanel
            projects={projects}
            selectedProjectId={selectedProjectId}
            daemon={daemon}
            theme={theme}
            onSelectProject={(id) => {
              setSelectedProjectId(id)
              setStageItem(null)
              setStageMode("chat")
              setExpandedPeekId(null)
            }}
            onToggleTheme={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
          />
        </aside>

        <div
          className="group relative flex w-2 shrink-0 cursor-col-resize items-center justify-center"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={(ev) => startHorizontalDrag("left", ev.clientX)}
        >
          <span className="h-7 w-0.5 rounded-full bg-transparent transition-colors group-hover:bg-ring" />
        </div>

        <main className="flex h-full min-w-0 flex-1 gap-2 overflow-hidden select-text">
          {stageMode !== "stage" && (
            <div className="flex min-w-0 flex-1 flex-col">
              <ChatPanel
                project={selectedProject}
                sessions={projectSessions}
                activeSessionId={activeSessionId}
                targetSessionId={targetSessionId}
                timeline={timeline}
                projectFiles={projectFiles}
                stageMode={stageMode}
                hasStageItem={stageItem !== null}
                composerText={composerText}
                attachedPaths={attachedPaths}
                sending={sending}
                onStageModeChange={setStageMode}
                onTargetSessionChange={setTargetSessionId}
                onComposerTextChange={setComposerText}
                onAddAttachment={handleAddAttachment}
                onRemoveAttachment={(rel) => setAttachedPaths((prev) => prev.filter((p) => p !== rel))}
                onSend={() => void handleSend()}
                onPeekSession={handleOpenTerminalStage}
                onFocusSession={(id) => {
                  setExpandedPeekId(id)
                  void fetchPeek(id)
                  setTargetSessionId(id)
                }}
              />
            </div>
          )}

          {stageItem && stageMode !== "chat" && (
            <div className="flex min-w-0 flex-[1.1] flex-col">
              <StagePanel
                item={stageItem}
                theme={theme}
                sessions={projectSessions}
                peekText={activeStagePeekText}
                onRefreshPeek={(id) => void fetchPeek(id)}
                onAddToComposer={handleAddToComposer}
                onClose={() => {
                  setStageItem(null)
                  setStageMode("chat")
                }}
              />
            </div>
          )}
        </main>

        <div
          className="group relative flex w-2 shrink-0 cursor-col-resize items-center justify-center"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={(ev) => startHorizontalDrag("right", ev.clientX)}
        >
          <span className="h-7 w-0.5 rounded-full bg-transparent transition-colors group-hover:bg-ring" />
        </div>

        <div ref={rightColumnRef} className="flex h-full shrink-0 flex-col select-text" style={{ width: rightWidth }}>
          <div
            className="flex min-h-36 flex-col overflow-hidden"
            style={{ height: `calc(${rightSplitPercent}% - 4px)` }}
          >
            <SessionsPanel
              sessions={projectSessions}
              theme={theme}
              expandedPeekId={expandedPeekId}
              peekCache={peekCache}
              onTogglePeek={handleTogglePeek}
              onRefreshPeek={(id) => void fetchPeek(id)}
              onOpenTerminalStage={handleOpenTerminalStage}
              onSelectForSend={(id) => {
                setTargetSessionId(id)
                showToast("Composer target switched to branch session")
              }}
              onInterrupt={(id) => void handleInterrupt(id)}
              onArchive={(id) => void handleArchive(id)}
            />
          </div>

          <div
            className="group relative flex h-2 shrink-0 cursor-row-resize items-center justify-center"
            role="separator"
            aria-orientation="horizontal"
            onMouseDown={(ev) => startRightVerticalDrag(ev.clientY)}
          >
            <span className="h-0.5 w-8 rounded-full bg-transparent transition-colors group-hover:bg-ring" />
          </div>

          <div
            className="flex min-h-36 flex-col overflow-hidden"
            style={{ height: `calc(${100 - rightSplitPercent}% - 4px)` }}
          >
            <KnowledgePanel
              files={projectFiles}
              activeFileId={activeStageFileId}
              onOpenFile={handleOpenFile}
              onAttachFile={(rel) => {
                handleAddAttachment(rel)
                showToast(`Attached @${rel}`)
              }}
            />
          </div>
        </div>

        {toast && (
          <div
            className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-popover px-3.5 py-1.5 text-xs font-medium text-popover-foreground shadow-lg"
            role="status"
            data-testid="toast-pill"
          >
            {toast}
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
