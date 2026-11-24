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
import { ChatConversation } from "./components/chat/chat-conversation.tsx"
import { ChatMessage } from "./components/chat/chat-message.tsx"
import { useChatScroll } from "./components/chat/hooks/use-chat-scroll.ts"
import { Avatar, AvatarFallback } from "./components/ui/avatar.tsx"
import { Badge } from "./components/ui/badge.tsx"
import { Button } from "./components/ui/button.tsx"
import { Collapsible, CollapsiblePanel } from "./components/ui/collapsible.tsx"
import {
  Composer,
  ComposerActionGroup,
  ComposerActions,
  ComposerInput,
  ComposerSubmit,
} from "./components/ui/composer.tsx"
import { Empty, EmptyDescription, EmptyTitle } from "./components/ui/empty.tsx"
import { Frame, FrameHeader, FramePanel, FrameTitle } from "./components/ui/frame.tsx"
import { Input } from "./components/ui/input.tsx"
import { Popover, PopoverPopup, PopoverTrigger } from "./components/ui/popover.tsx"
import { ScrollArea } from "./components/ui/scroll-area.tsx"
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./components/ui/select.tsx"
import { Tabs, TabsList, TabsTab } from "./components/ui/tabs.tsx"

function formatTime(ms: number): string {
  const date = new Date(ms)

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function initialsOf(label: string): string {
  const clean = label.trim()

  if (clean.length === 0) return "VB"

  return clean.slice(0, 2).toUpperCase()
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
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-xs/5"
      data-testid={`agent-report-card-${report.agentId.slice(0, 8)}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/80 bg-muted/35 px-2.5 py-1.5">
        <button
          type="button"
          className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <Bot className="size-3.5 shrink-0 text-info-foreground" aria-hidden="true" />
          <span className="truncate text-xs font-semibold text-foreground">
            {session?.name ?? `agent-${report.agentId.slice(0, 8)}`}
          </span>
          <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
            {report.agentId.slice(0, 8)}
          </span>
          {session?.git?.branch ? (
            <Badge variant="outline" size="sm" className="max-w-44 gap-1 truncate font-mono text-[10px]">
              <GitBranch className="size-2.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{session.git.branch}</span>
            </Badge>
          ) : null}
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="outline" size="xs" onClick={() => onPeekSession(report.agentId)}>
            <Terminal className="size-3" aria-hidden="true" />
            Peek Terminal
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => onFocusSession(report.agentId)}>
            Open Branch
          </Button>
        </div>
      </div>

      <div className="px-3 py-2 text-[12.5px] font-medium text-foreground">{report.firstLine}</div>

      {report.details.length > 0 && (
        <CollapsiblePanel className="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
          <div
            className="markdown-prose"
            dangerouslySetInnerHTML={{ __html: renderSafeMarkdownHtml(report.details) }}
          />
        </CollapsiblePanel>
      )}
    </Collapsible>
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

  const [atOpen, setAtOpen] = useState(false)
  const [atFilter, setAtFilter] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const chatScroll = useChatScroll({ itemCount: timeline.length })

  const sessionById = useMemo(() => {
    const map = new Map<string, SessionItem>()

    for (const s of sessions) {
      map.set(s.id, s)
    }

    return map
  }, [sessions])

  const activeSession = activeSessionId ? sessionById.get(activeSessionId) : undefined
  const targetSession = targetSessionId ? sessionById.get(targetSessionId) : undefined

  const filteredFiles = useMemo(() => {
    const q = atFilter.trim().toLowerCase()

    return projectFiles.filter(
      (f) =>
        !attachedPaths.includes(f.relativePath) &&
        (q.length === 0 || f.relativePath.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)),
    )
  }, [projectFiles, attachedPaths, atFilter])

  useEffect(() => {
    const el = textareaRef.current

    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(176, Math.max(44, el.scrollHeight))}px`
  }, [composerText])

  return (
    <Frame className="h-full min-h-0 flex-1 overflow-hidden" data-testid="chat-panel">
      <FrameHeader className="flex-row items-center justify-between gap-2 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <FrameTitle className="truncate text-xs font-semibold tracking-tight">
            Vibest/{project?.name ?? "workspace"}
          </FrameTitle>
          {project?.branch ? (
            <Badge variant="outline" size="sm" className="gap-1 font-mono text-[10px]">
              <GitBranch className="size-2.5" aria-hidden="true" />
              {project.branch}
            </Badge>
          ) : null}
          {activeSession ? (
            <Badge variant="secondary" size="sm" className="hidden font-mono text-[10px] sm:inline-flex">
              {activeSession.harness}
              {activeSession.model ? ` · ${activeSession.model}` : ""}
            </Badge>
          ) : null}
        </div>

        <Tabs
          value={stageMode}
          onValueChange={(val) => {
            if (val === "chat" || val === "split" || val === "stage") {
              onStageModeChange(val)
            }
          }}
        >
          <TabsList size="sm" aria-label="Center workspace layout">
            <TabsTab value="chat" className="gap-1 text-[11px]" data-testid="mode-chat-btn">
              <MessageSquare className="size-3" aria-hidden="true" />
              Chat
            </TabsTab>
            <TabsTab value="split" disabled={!hasStageItem} className="gap-1 text-[11px]" data-testid="mode-split-btn">
              <Columns2 className="size-3" aria-hidden="true" />
              Split
            </TabsTab>
            <TabsTab value="stage" disabled={!hasStageItem} className="gap-1 text-[11px]" data-testid="mode-stage-btn">
              <PanelRight className="size-3" aria-hidden="true" />
              Stage
            </TabsTab>
          </TabsList>
        </Tabs>
      </FrameHeader>

      <FramePanel className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <ChatConversation
          scroll={chatScroll}
          label="Project conversation"
          jumpLabel="Jump to latest"
          className="min-h-0 flex-1"
          contentClassName="flex flex-col gap-3 px-4 py-3.5"
          data-testid="chat-stream"
        >
          {timeline.map((entry) => {
            const blocks = parseVibestMessageBlocks(entry.content)
            const isOwn = entry.role === "user"

            return (
              <div key={entry.id} data-testid={`chat-turn-${entry.id}`} className="w-full">
                <ChatMessage
                  side={isOwn ? "outgoing" : "incoming"}
                  bubble={false}
                  avatar={
                    <Avatar className="size-6 text-[10px]">
                      <AvatarFallback
                        className={isOwn ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"}
                      >
                        {initialsOf(entry.senderLabel)}
                      </AvatarFallback>
                    </Avatar>
                  }
                  className="w-full"
                >
                  <div
                    className={
                      isOwn
                        ? "flex w-full flex-col gap-2 rounded-xl border border-border bg-accent/70 px-3.5 py-2.5 shadow-xs/5"
                        : "flex w-full flex-col gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 shadow-xs/5"
                    }
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-foreground">{entry.senderLabel}</span>
                      <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
                        {formatTime(entry.createdAt)}
                      </span>
                      {entry.status === "working" && (
                        <Badge variant="info" size="sm">
                          Working
                        </Badge>
                      )}
                      {entry.status === "blocked" && (
                        <Badge variant="warning" size="sm">
                          Needs You
                        </Badge>
                      )}
                    </div>

                    {entry.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {entry.attachments.map((att) => (
                          <Badge key={att} variant="info" size="sm" className="gap-1 font-mono text-[10.5px]">
                            <FileText className="size-2.5" aria-hidden="true" />@{att}
                          </Badge>
                        ))}
                      </div>
                    )}

                    <div className="flex flex-col gap-2 text-[13px] text-foreground">
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
                            <div
                              key={`${entry.id}-sys-${idx}`}
                              className="flex items-center gap-2 rounded-lg border border-info/25 bg-info/10 px-2.5 py-1.5 text-xs text-foreground"
                            >
                              <Sparkles className="size-3.5 shrink-0 text-info-foreground" aria-hidden="true" />
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
                  </div>
                </ChatMessage>
              </div>
            )
          })}

          {timeline.length === 0 && (
            <Empty className="my-auto py-12">
              <EmptyTitle className="text-sm">Ready to orchestrate {project?.name ?? "project"}</EmptyTitle>
              <EmptyDescription className="text-xs">
                Send a prompt below or open an artifact from the right panel.
              </EmptyDescription>
            </Empty>
          )}
        </ChatConversation>

        <div className="shrink-0 border-t border-border/70 bg-muted/20 p-2.5" data-testid="composer-dock">
          <Composer
            onSubmit={(ev) => {
              ev.preventDefault()
              onSend()
            }}
          >
            {attachedPaths.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-2.5 pt-2" data-testid="composer-chips">
                {attachedPaths.map((rel) => (
                  <Badge key={rel} variant="info" size="sm" className="gap-1 pr-1 font-mono text-[10.5px]">
                    <FileText className="size-2.5" aria-hidden="true" />
                    <span>@{rel}</span>
                    <button
                      type="button"
                      className="inline-flex cursor-pointer rounded hover:bg-info/20"
                      aria-label={`Remove ${rel}`}
                      onClick={() => onRemoveAttachment(rel)}
                    >
                      <X className="size-2.5" aria-hidden="true" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}

            <ComposerInput
              ref={textareaRef}
              data-testid="composer-textarea"
              placeholder="Message session or type @ to attach project artifacts, docs, or memories... (Enter to send)"
              value={composerText}
              onChange={(ev) => {
                const next = ev.target.value
                onComposerTextChange(next)

                if (next.endsWith("@")) {
                  setAtOpen(true)
                }
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && !ev.shiftKey) {
                  ev.preventDefault()
                  onSend()
                }
              }}
            />

            <ComposerActions className="border-t border-border/60">
              <ComposerActionGroup>
                <Popover open={atOpen} onOpenChange={setAtOpen}>
                  <PopoverTrigger
                    render={
                      <Button type="button" variant="outline" size="xs" data-testid="composer-at-btn">
                        <AtSign className="size-3" aria-hidden="true" />
                        Context
                      </Button>
                    }
                  />
                  <PopoverPopup side="top" align="start" className="w-80 p-2" data-testid="at-picker-popover">
                    <div className="flex flex-col gap-2">
                      <Input
                        type="text"
                        size="sm"
                        placeholder="Attach artifact, doc, or memory..."
                        value={atFilter}
                        onChange={(ev) => setAtFilter(ev.target.value)}
                        autoFocus
                      />
                      <ScrollArea className="max-h-48">
                        <div className="flex flex-col gap-0.5">
                          {filteredFiles.slice(0, 10).map((file) => (
                            <button
                              key={file.id}
                              type="button"
                              data-testid={`at-pick-${file.name}`}
                              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                              onClick={() => {
                                onAddAttachment(file.relativePath)
                                setAtOpen(false)
                                setAtFilter("")
                              }}
                            >
                              <FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{file.relativePath}</span>
                              <Badge variant="outline" size="sm">
                                {file.category}
                              </Badge>
                            </button>
                          ))}
                          {filteredFiles.length === 0 && (
                            <div className="py-4 text-center text-xs text-muted-foreground">No matching files</div>
                          )}
                        </div>
                      </ScrollArea>
                    </div>
                  </PopoverPopup>
                </Popover>

                <Select
                  value={targetSessionId ?? ""}
                  onValueChange={(val) => {
                    if (val) onTargetSessionChange(val)
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="h-6 min-h-6 w-auto max-w-52 px-2 text-[11px]"
                    data-testid="composer-target-select"
                    aria-label="Target session"
                  >
                    <SelectValue>
                      {targetSession
                        ? targetSession.isEntry
                          ? `Entry · ${targetSession.name}`
                          : `${targetSession.name} (${targetSession.git?.branch || targetSession.harness})`
                        : "Select session"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {sessions.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.isEntry ? `Entry · ${s.name}` : `${s.name} (${s.git?.branch || s.harness})`}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </ComposerActionGroup>

              <ComposerSubmit
                data-testid="composer-send-btn"
                disabled={sending || composerText.trim().length === 0 || !targetSessionId}
              >
                <Send className="size-3" aria-hidden="true" />
                {sending ? "Sending..." : "Send"}
              </ComposerSubmit>
            </ComposerActions>
          </Composer>
        </div>
      </FramePanel>
    </Frame>
  )
}
