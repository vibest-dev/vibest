import { Cpu, FolderGit2, Moon, Search, Server, Sun } from "lucide-react"
import { useMemo, useState } from "react"

import type { DaemonStatus, ProjectSummary, ThemeMode } from "../types.ts"
import { Badge } from "./components/ui/badge.tsx"
import { Button } from "./components/ui/button.tsx"
import { Empty, EmptyDescription, EmptyTitle } from "./components/ui/empty.tsx"
import { Frame, FrameHeader, FramePanel, FrameTitle } from "./components/ui/frame.tsx"
import { InputGroup, InputGroupAddon, InputGroupInput } from "./components/ui/input-group.tsx"
import { Kbd } from "./components/ui/kbd.tsx"
import { ScrollArea } from "./components/ui/scroll-area.tsx"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./components/ui/tooltip.tsx"
import { cn } from "./lib/utils.ts"

function shortenHomePath(dir: string): string {
  return dir.replace(/^\/Users\/[^/]+/, "~").replace(/^\/Volumes\/SSD\/GitHub\//, "SSD/GitHub/")
}

function formatLoadLabel(daemon: DaemonStatus): string {
  if (!daemon.load) return daemon.connected ? "online" : "offline"

  const cpuText =
    daemon.load.cpuUtilization !== null
      ? `${Math.round(daemon.load.cpuUtilization * 100)}%`
      : `${daemon.load.cpuCount}c`

  const usedGb = Math.max(0, daemon.load.memoryTotalBytes - daemon.load.memoryAvailableBytes) / 1024 ** 3
  const totalGb = Math.max(1, daemon.load.memoryTotalBytes) / 1024 ** 3

  return `${cpuText} · ${usedGb.toFixed(1)}/${totalGb.toFixed(0)}G`
}

function activityDotClass(activity: ProjectSummary["activity"]): string {
  switch (activity) {
    case "blocked":
      return "bg-warning shadow-[0_0_0_2px_color-mix(in_srgb,var(--warning)_24%,transparent)]"
    case "working":
      return "bg-info shadow-[0_0_0_2px_color-mix(in_srgb,var(--info)_24%,transparent)] animate-pulse"
    case "done":
      return "bg-success"
    case "idle":
      return "bg-muted-foreground/50"
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
    <Frame className="h-full min-h-0 flex-1 overflow-hidden" data-testid="projects-panel">
      <FrameHeader className="flex-row items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <FrameTitle className="text-xs font-semibold tracking-tight">Projects</FrameTitle>
          <Badge variant="outline" size="sm" className="tabular-nums">
            {projects.length}
          </Badge>
        </div>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="theme-toggle-btn"
                aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                onClick={onToggleTheme}
              >
                {theme === "dark" ? (
                  <Sun className="size-3.5" aria-hidden="true" />
                ) : (
                  <Moon className="size-3.5" aria-hidden="true" />
                )}
              </Button>
            }
          />
          <TooltipPopup>{theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}</TooltipPopup>
        </Tooltip>
      </FrameHeader>

      <FramePanel className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div className="flex flex-col gap-2 border-b border-border p-2.5">
          <InputGroup>
            <InputGroupAddon align="inline-start">
              <Search className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              type="text"
              size="sm"
              data-testid="project-filter-input"
              placeholder="Filter projects..."
              value={query}
              onChange={(ev) => setQuery(ev.target.value)}
            />
            <InputGroupAddon align="inline-end">
              <Kbd>⌘K</Kbd>
            </InputGroupAddon>
          </InputGroup>

          <div
            className="flex items-center justify-between gap-1.5"
            data-testid="daemon-status-pill"
            title={daemon.socket}
          >
            <Badge variant={daemon.connected ? "success" : "error"} size="sm" className="gap-1.5">
              <span className={cn("size-1.5 rounded-full", daemon.connected ? "bg-success" : "bg-destructive")} />
              vibestd
            </Badge>
            <Badge variant="outline" size="sm" className="gap-1 font-mono text-[10.5px] tabular-nums">
              <Cpu className="size-3 text-muted-foreground" aria-hidden="true" />
              {formatLoadLabel(daemon)}
            </Badge>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 p-2" role="list">
            {filtered.map((project) => {
              const active = project.id === selectedProjectId

              return (
                <button
                  key={project.id}
                  type="button"
                  role="listitem"
                  data-testid={`project-item-${project.name}`}
                  className={cn(
                    "group flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
                    active
                      ? "border-border bg-accent text-accent-foreground shadow-xs/5"
                      : "border-transparent bg-transparent hover:bg-accent/60",
                  )}
                  onClick={() => onSelectProject(project.id)}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn("size-2 shrink-0 rounded-full", activityDotClass(project.activity))} />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight text-foreground">
                      {project.name}
                    </span>
                    {project.needsYouCount > 0 ? (
                      <Badge variant="warning" size="sm" className="tabular-nums">
                        Needs You · {project.needsYouCount}
                      </Badge>
                    ) : project.activeSubagents > 0 ? (
                      <Badge variant="info" size="sm" className="tabular-nums">
                        {project.activeSubagents} active
                      </Badge>
                    ) : null}
                  </div>

                  <div className="truncate font-mono text-[10.5px] text-muted-foreground" title={project.directory}>
                    {shortenHomePath(project.directory)}
                  </div>

                  <div className="flex flex-wrap items-center gap-1">
                    <Badge variant="outline" size="sm" className="gap-1 font-normal text-muted-foreground">
                      <Server className="size-2.5" aria-hidden="true" />
                      {project.machine}
                    </Badge>
                    <Badge variant="secondary" size="sm" className="max-w-36 truncate font-mono text-[10px]">
                      {project.branch}
                    </Badge>
                  </div>
                </button>
              )
            })}

            {filtered.length === 0 && (
              <Empty className="py-8">
                <EmptyTitle className="text-xs">No matching projects</EmptyTitle>
                <EmptyDescription className="text-xs">Try clearing "{query}".</EmptyDescription>
              </Empty>
            )}
          </div>
        </ScrollArea>
      </FramePanel>
    </Frame>
  )
}
