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
import { Badge } from "./components/ui/badge.tsx"
import { Button } from "./components/ui/button.tsx"
import { Collapsible, CollapsiblePanel } from "./components/ui/collapsible.tsx"
import { Empty, EmptyDescription, EmptyTitle } from "./components/ui/empty.tsx"
import { Frame, FrameHeader, FramePanel, FrameTitle } from "./components/ui/frame.tsx"
import { ScrollArea } from "./components/ui/scroll-area.tsx"
import { Tabs, TabsList, TabsTab } from "./components/ui/tabs.tsx"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./components/ui/tooltip.tsx"
import { cn } from "./lib/utils.ts"
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
  if (session.needsYou) return "bg-warning shadow-[0_0_0_2px_color-mix(in_srgb,var(--warning)_24%,transparent)]"

  if (session.status === "working")
    return "bg-info shadow-[0_0_0_2px_color-mix(in_srgb,var(--info)_24%,transparent)] animate-pulse"

  if (session.status === "done") return "bg-success"

  return "bg-muted-foreground/50"
}

function statusBadgeVariant(session: SessionItem): "warning" | "info" | "success" | "secondary" {
  if (session.needsYou) return "warning"

  if (session.status === "working") return "info"

  if (session.status === "done") return "success"

  return "secondary"
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
    <Frame className="h-full min-h-0 flex-1 overflow-hidden" data-testid="sessions-panel">
      <FrameHeader className="flex-row items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Layers className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <FrameTitle className="text-xs font-semibold tracking-tight">Sessions</FrameTitle>
          <Badge variant="outline" size="sm" className="tabular-nums">
            {counts.all}
          </Badge>
        </div>

        <Badge variant="info" size="sm" className="gap-1.5" title="Live via vibestd Watch SSE">
          <span className="size-1.5 animate-pulse rounded-full bg-info" />
          Watch
        </Badge>
      </FrameHeader>

      <FramePanel className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div className="border-b border-border px-2.5 py-1.5">
          <Tabs
            value={filter}
            onValueChange={(val) => {
              if (val === "all" || val === "needs_you" || val === "working" || val === "done") {
                setFilter(val)
              }
            }}
          >
            <TabsList className="w-full" size="sm">
              <TabsTab value="all" className="flex-1 text-[11px]" data-testid="sessions-filter-all">
                All <span className="tabular-nums opacity-70">{counts.all}</span>
              </TabsTab>
              <TabsTab value="needs_you" className="flex-1 text-[11px]" data-testid="sessions-filter-needs-you">
                Needs You <span className="tabular-nums opacity-70">{counts.needsYou}</span>
              </TabsTab>
              <TabsTab value="working" className="flex-1 text-[11px]" data-testid="sessions-filter-working">
                Working <span className="tabular-nums opacity-70">{counts.working}</span>
              </TabsTab>
              <TabsTab value="done" className="flex-1 text-[11px]" data-testid="sessions-filter-done">
                Done <span className="tabular-nums opacity-70">{counts.done}</span>
              </TabsTab>
            </TabsList>
          </Tabs>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 p-2">
            {filtered.map((session) => {
              const isExpanded = expandedPeekId === session.id

              return (
                <Collapsible
                  key={session.id}
                  open={isExpanded}
                  onOpenChange={() => onTogglePeek(session.id)}
                  className={cn(
                    "overflow-hidden rounded-xl border bg-background/80 transition-colors",
                    isExpanded ? "border-ring/50 shadow-xs" : "border-border",
                  )}
                  data-testid={`session-card-${session.id.slice(0, 8)}`}
                >
                  <button
                    type="button"
                    className="flex w-full cursor-pointer flex-col gap-1.5 px-2.5 pt-2.5 pb-2 text-left transition-colors hover:bg-accent/50"
                    onClick={() => onTogglePeek(session.id)}
                    aria-expanded={isExpanded}
                  >
                    <div className="flex items-center gap-1.5">
                      {isExpanded ? (
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                      <span className={cn("size-2 shrink-0 rounded-full", statusDotClass(session))} />
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                        {session.name}
                      </span>
                      <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
                        {formatElapsed(session.createdAt, session.lastActive)}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant={statusBadgeVariant(session)} size="sm">
                        {statusLabel(session)}
                      </Badge>
                      {session.git?.branch ? (
                        <Badge variant="outline" size="sm" className="max-w-44 gap-1 truncate font-mono text-[10px]">
                          <GitBranch className="size-2.5 shrink-0" aria-hidden="true" />
                          <span className="truncate">{session.git.branch}</span>
                        </Badge>
                      ) : null}
                      {session.git?.pushed ? (
                        <Badge variant="success" size="sm" className="gap-1">
                          <CloudUpload className="size-2.5" aria-hidden="true" />
                          pushed
                        </Badge>
                      ) : session.git?.saved ? (
                        <Badge variant="secondary" size="sm">
                          saved
                        </Badge>
                      ) : null}
                      <Badge variant="outline" size="sm" className="font-mono text-[10px] text-muted-foreground">
                        {session.harness}
                        {session.model ? `/${session.model}` : ""}
                      </Badge>
                    </div>

                    {session.summary.length > 0 && (
                      <p className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{session.summary}</p>
                    )}
                  </button>

                  <div className="flex items-center gap-1 border-t border-border/70 bg-muted/25 px-2 py-1.5">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            data-testid={`session-peek-btn-${session.id.slice(0, 8)}`}
                            onClick={() => onTogglePeek(session.id)}
                          >
                            <Terminal className="size-3" aria-hidden="true" />
                            Peek
                          </Button>
                        }
                      />
                      <TooltipPopup>Toggle live @wterm/dom terminal peek</TooltipPopup>
                    </Tooltip>

                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid={`session-send-btn-${session.id.slice(0, 8)}`}
                      onClick={() => onSelectForSend(session.id)}
                    >
                      <Send className="size-3" aria-hidden="true" />
                      Send
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid={`session-interrupt-btn-${session.id.slice(0, 8)}`}
                      onClick={() => onInterrupt(session.id)}
                    >
                      <Square className="size-2.5" aria-hidden="true" />
                      Interrupt
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="ml-auto text-muted-foreground hover:text-destructive-foreground"
                      data-testid={`session-archive-btn-${session.id.slice(0, 8)}`}
                      onClick={() => onArchive(session.id)}
                    >
                      <Archive className="size-3" aria-hidden="true" />
                      Archive
                    </Button>
                  </div>

                  <CollapsiblePanel className="border-t border-border/70 bg-muted/20 p-1.5">
                    <WtermView
                      content={peekCache[session.id] ?? "Connecting to terminal stream..."}
                      theme={theme}
                      compact
                      title={`@wterm/dom · ${session.git?.branch || session.name}`}
                      onRefresh={() => onRefreshPeek(session.id)}
                      onExpand={() => onOpenTerminalStage(session.id)}
                    />
                  </CollapsiblePanel>
                </Collapsible>
              )
            })}

            {filtered.length === 0 && (
              <Empty className="py-8">
                <EmptyTitle className="text-xs">No branch sessions</EmptyTitle>
                <EmptyDescription className="text-xs">No subagents match this filter.</EmptyDescription>
              </Empty>
            )}
          </div>
        </ScrollArea>
      </FramePanel>
    </Frame>
  )
}
