import {
  AtSign,
  BookOpen,
  Brain,
  FileCode2,
  FileImage,
  FileText,
  Film,
  Package,
  Search,
  SlidersHorizontal,
} from "lucide-react"
import { useMemo, useState } from "react"

import type { KnowledgeCategory, ProjectFileEntry } from "../types.ts"
import { Badge } from "./components/ui/badge.tsx"
import { Button } from "./components/ui/button.tsx"
import { Empty, EmptyDescription, EmptyTitle } from "./components/ui/empty.tsx"
import { Frame, FrameHeader, FramePanel } from "./components/ui/frame.tsx"
import { InputGroup, InputGroupAddon, InputGroupInput } from "./components/ui/input-group.tsx"
import { ScrollArea } from "./components/ui/scroll-area.tsx"
import { Tabs, TabsList, TabsTab } from "./components/ui/tabs.tsx"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./components/ui/tooltip.tsx"
import { cn } from "./lib/utils.ts"

type TabKey = Exclude<KnowledgeCategory, "preferences">

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`

  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FileKindIcon(props: { readonly kind: ProjectFileEntry["kind"] }) {
  switch (props.kind) {
    case "html":
      return <FileCode2 className="size-3.5 shrink-0 text-warning-foreground" aria-hidden="true" />
    case "excalidraw":
      return <Package className="size-3.5 shrink-0 text-info-foreground" aria-hidden="true" />
    case "image":
      return <FileImage className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    case "video":
      return <Film className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    default:
      return <FileText className="size-3.5 shrink-0 text-success-foreground" aria-hidden="true" />
  }
}

export function KnowledgePanel(props: {
  readonly files: ReadonlyArray<ProjectFileEntry>
  readonly activeFileId: string | null
  readonly onOpenFile: (file: ProjectFileEntry) => void
  readonly onAttachFile: (relativePath: string) => void
}) {
  const { files, activeFileId, onOpenFile, onAttachFile } = props
  const [tab, setTab] = useState<TabKey>("artifacts")
  const [query, setQuery] = useState("")

  const preferencesFile = useMemo(() => files.find((f) => f.category === "preferences"), [files])

  const counts = useMemo(() => {
    let artifacts = 0
    let docs = 0
    let memories = 0

    for (const f of files) {
      if (f.category === "artifacts") artifacts += 1
      else if (f.category === "docs") docs += 1
      else if (f.category === "memories") memories += 1
    }

    return { artifacts, docs, memories }
  }, [files])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()

    return files.filter(
      (f) =>
        f.category === tab &&
        (q.length === 0 || f.name.toLowerCase().includes(q) || f.relativePath.toLowerCase().includes(q)),
    )
  }, [files, tab, query])

  return (
    <Frame className="h-full min-h-0 flex-1 overflow-hidden" data-testid="knowledge-panel">
      <FrameHeader className="flex-row items-center justify-between gap-2 px-2.5 py-1.5">
        <Tabs
          value={tab}
          onValueChange={(val) => {
            if (val === "artifacts" || val === "docs" || val === "memories") {
              setTab(val)
            }
          }}
        >
          <TabsList size="sm">
            <TabsTab value="artifacts" className="gap-1 text-[11px]" data-testid="tab-artifacts">
              <Package className="size-3" aria-hidden="true" />
              Artifacts <span className="tabular-nums opacity-70">{counts.artifacts}</span>
            </TabsTab>
            <TabsTab value="docs" className="gap-1 text-[11px]" data-testid="tab-docs">
              <BookOpen className="size-3" aria-hidden="true" />
              Docs <span className="tabular-nums opacity-70">{counts.docs}</span>
            </TabsTab>
            <TabsTab value="memories" className="gap-1 text-[11px]" data-testid="tab-memories">
              <Brain className="size-3" aria-hidden="true" />
              Memories <span className="tabular-nums opacity-70">{counts.memories}</span>
            </TabsTab>
          </TabsList>
        </Tabs>

        {preferencesFile && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={activeFileId === preferencesFile.id ? "secondary" : "ghost"}
                  size="icon-xs"
                  data-testid="open-preferences-btn"
                  aria-label="Open preferences.md"
                  onClick={() => onOpenFile(preferencesFile)}
                >
                  <SlidersHorizontal className="size-3.5" aria-hidden="true" />
                </Button>
              }
            />
            <TooltipPopup>Open preferences.md</TooltipPopup>
          </Tooltip>
        )}
      </FrameHeader>

      <FramePanel className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div className="border-b border-border p-2">
          <InputGroup>
            <InputGroupAddon align="inline-start">
              <Search className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              type="text"
              size="sm"
              data-testid="knowledge-search-input"
              placeholder={`Filter ${tab}...`}
              value={query}
              onChange={(ev) => setQuery(ev.target.value)}
            />
          </InputGroup>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 p-2">
            {filtered.map((file) => {
              const active = file.id === activeFileId

              return (
                <div
                  key={file.id}
                  className={cn(
                    "flex items-center gap-1 rounded-lg border pr-1 transition-colors",
                    active
                      ? "border-border bg-accent text-accent-foreground shadow-xs/5"
                      : "border-transparent hover:bg-accent/60",
                  )}
                  data-testid={`knowledge-file-${file.name}`}
                >
                  <button
                    type="button"
                    className="file-row-main flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-left"
                    onClick={() => onOpenFile(file)}
                  >
                    <FileKindIcon kind={file.kind} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-xs font-medium text-foreground">{file.name}</span>
                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {file.relativePath} · <span className="tabular-nums">{formatSize(file.size)}</span>
                      </span>
                    </div>
                    <Badge variant="outline" size="sm" className="shrink-0 font-mono text-[10px]">
                      {file.extension}
                    </Badge>
                  </button>

                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          data-testid={`attach-file-${file.name}`}
                          aria-label={`Attach @${file.relativePath}`}
                          onClick={() => onAttachFile(file.relativePath)}
                        >
                          <AtSign className="size-3" aria-hidden="true" />
                        </Button>
                      }
                    />
                    <TooltipPopup>Attach @{file.relativePath} to Composer</TooltipPopup>
                  </Tooltip>
                </div>
              )
            })}

            {filtered.length === 0 && (
              <Empty className="py-8">
                <EmptyTitle className="text-xs">No files in {tab}/</EmptyTitle>
                <EmptyDescription className="text-xs">Agent outputs appear here live.</EmptyDescription>
              </Empty>
            )}
          </div>
        </ScrollArea>
      </FramePanel>
    </Frame>
  )
}
