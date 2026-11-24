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

type TabKey = Exclude<KnowledgeCategory, "preferences">

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`

  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FileKindIcon(props: { readonly kind: ProjectFileEntry["kind"] }) {
  switch (props.kind) {
    case "html":
      return <FileCode2 size={13} className="file-icon is-html" aria-hidden="true" />
    case "excalidraw":
      return <Package size={13} className="file-icon is-excalidraw" aria-hidden="true" />
    case "image":
      return <FileImage size={13} className="file-icon is-media" aria-hidden="true" />
    case "video":
      return <Film size={13} className="file-icon is-media" aria-hidden="true" />
    default:
      return <FileText size={13} className="file-icon is-md" aria-hidden="true" />
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
    <section className="panel panel-knowledge" data-testid="knowledge-panel">
      <header className="panel-header knowledge-header">
        <div className="segmented" role="tablist" aria-label="Knowledge and outputs">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "artifacts"}
            data-testid="tab-artifacts"
            className={`segmented-btn ${tab === "artifacts" ? "is-active" : ""}`}
            onClick={() => setTab("artifacts")}
          >
            <Package size={11} aria-hidden="true" />
            Artifacts <span className="tabular-nums">{counts.artifacts}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "docs"}
            data-testid="tab-docs"
            className={`segmented-btn ${tab === "docs" ? "is-active" : ""}`}
            onClick={() => setTab("docs")}
          >
            <BookOpen size={11} aria-hidden="true" />
            Docs <span className="tabular-nums">{counts.docs}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "memories"}
            data-testid="tab-memories"
            className={`segmented-btn ${tab === "memories" ? "is-active" : ""}`}
            onClick={() => setTab("memories")}
          >
            <Brain size={11} aria-hidden="true" />
            Memories <span className="tabular-nums">{counts.memories}</span>
          </button>
        </div>

        {preferencesFile && (
          <button
            type="button"
            className={`icon-btn ${activeFileId === preferencesFile.id ? "is-active" : ""}`}
            data-testid="open-preferences-btn"
            title="Open preferences.md"
            onClick={() => onOpenFile(preferencesFile)}
          >
            <SlidersHorizontal size={13} aria-hidden="true" />
          </button>
        )}
      </header>

      <div className="knowledge-search">
        <div className="search-input-wrap">
          <Search size={12} className="search-icon" aria-hidden="true" />
          <input
            type="text"
            className="search-input"
            data-testid="knowledge-search-input"
            placeholder={`Filter ${tab}...`}
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
          />
        </div>
      </div>

      <div className="panel-scroll knowledge-list">
        {filtered.map((file) => {
          const active = file.id === activeFileId

          return (
            <div
              key={file.id}
              className={`file-row ${active ? "is-selected" : ""}`}
              data-testid={`knowledge-file-${file.name}`}
            >
              <button type="button" className="file-row-main" onClick={() => onOpenFile(file)}>
                <FileKindIcon kind={file.kind} />
                <div className="file-row-text">
                  <span className="file-row-name">{file.name}</span>
                  <span className="file-row-sub">
                    {file.relativePath} · <span className="tabular-nums">{formatSize(file.size)}</span>
                  </span>
                </div>
                <span className="file-ext-pill">{file.extension}</span>
              </button>

              <button
                type="button"
                className="icon-btn file-attach-btn"
                title={`Attach @${file.relativePath} to Composer`}
                data-testid={`attach-file-${file.name}`}
                onClick={() => onAttachFile(file.relativePath)}
              >
                <AtSign size={12} aria-hidden="true" />
              </button>
            </div>
          )
        })}

        {filtered.length === 0 && <div className="empty-state">No files in {tab}/.</div>}
      </div>
    </section>
  )
}
