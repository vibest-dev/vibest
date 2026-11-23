import { FilePlus2, Save } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import { renderSafeMarkdownHtml } from "../markdown-safe.ts"
import type { KnowledgeFileEntry } from "../schema.ts"
import { hubApi } from "./api.ts"

export function KnowledgeView(props: { projectId: string; refreshSignal: number }) {
  const { projectId, refreshSignal } = props
  const [files, setFiles] = useState<KnowledgeFileEntry[]>([])
  const [selectedPath, setSelectedPath] = useState<string>("preferences.md")
  const [content, setContent] = useState<string>("")
  const [mode, setMode] = useState<"edit" | "preview">("edit")
  const [saving, setSaving] = useState(false)
  const [savedBanner, setSavedBanner] = useState<string | null>(null)
  const [newPathInput, setNewPathInput] = useState("")
  const [showNewInput, setShowNewInput] = useState(false)

  const loadFiles = useCallback(async () => {
    const res = await hubApi.listKnowledgeFiles(projectId)
    setFiles(res.files)

    if (res.files.length > 0 && !res.files.some((f) => f.relativePath === selectedPath)) {
      const first = res.files[0]

      if (first) setSelectedPath(first.relativePath)
    }
  }, [projectId, selectedPath])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles, refreshSignal])

  useEffect(() => {
    if (!selectedPath) return
    void hubApi
      .readKnowledgeFile(projectId, selectedPath)
      .then((res) => setContent(res.content))
      .catch(() => setContent(""))
  }, [projectId, selectedPath])

  const handleSave = async () => {
    if (!selectedPath) return
    setSaving(true)

    try {
      await hubApi.saveKnowledgeFile(projectId, selectedPath, content)
      setSavedBanner("Saved")
      await loadFiles()
      setTimeout(() => setSavedBanner(null), 2000)
    } finally {
      setSaving(false)
    }
  }

  const handleCreateFile = async () => {
    const cleaned = newPathInput.trim().replace(/^\/+|\/+$/g, "")

    if (!cleaned || cleaned === "memories" || cleaned === "docs") return

    const ensureAllowedExt = (candidate: string): string =>
      /\.(md|txt|json)$/.test(candidate) ? candidate : `${candidate}.md`

    const targetPath =
      cleaned === "preferences.md"
        ? "preferences.md"
        : cleaned.startsWith("memories/") || cleaned.startsWith("docs/")
          ? ensureAllowedExt(cleaned)
          : `memories/${ensureAllowedExt(cleaned)}`

    await hubApi.saveKnowledgeFile(projectId, targetPath, `# ${targetPath}\n\n`)
    setNewPathInput("")
    setShowNewInput(false)
    await loadFiles()
    setSelectedPath(targetPath)
  }

  return (
    <div className="page-scroll" data-testid="knowledge-view">
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Knowledge</h1>
            <p className="page-lede">This project’s preferences.md, memories/, and docs/. Edits stay inside the hub.</p>
          </div>
          <button
            type="button"
            data-testid="new-knowledge-file-btn"
            className="btn"
            aria-expanded={showNewInput}
            onClick={() => setShowNewInput((v) => !v)}
          >
            <FilePlus2 size={15} aria-hidden="true" /> New file
          </button>
        </header>

        {showNewInput && (
          <div className="new-file-row">
            <input
              className="input"
              aria-label="New file path"
              placeholder="memories/new-note.md or docs/design/topic.md"
              value={newPathInput}
              onChange={(ev) => setNewPathInput(ev.target.value)}
            />
            <button type="button" className="btn btn-primary" onClick={() => void handleCreateFile()}>
              Create
            </button>
          </div>
        )}

        <div className="knowledge-layout">
          <nav className="file-list" aria-labelledby="knowledge-files-title">
            <h2 className="file-list-title" id="knowledge-files-title">
              Files <span className="section-count">{files.length}</span>
            </h2>
            {files.map((file) => (
              <button
                key={file.relativePath}
                type="button"
                data-testid={`knowledge-file-${file.relativePath}`}
                aria-current={selectedPath === file.relativePath ? "true" : undefined}
                className={`file-btn ${selectedPath === file.relativePath ? "active" : ""}`}
                onClick={() => setSelectedPath(file.relativePath)}
              >
                <span className="file-path">{file.relativePath}</span>
                <span className="file-category">{file.category}</span>
              </button>
            ))}
          </nav>

          <section className="editor-pane" aria-labelledby="knowledge-editor-title">
            <div className="editor-head">
              <h2 className="editor-title" id="knowledge-editor-title">
                {selectedPath}
                {savedBanner && (
                  <span className="status status-ok" role="status">
                    {savedBanner}
                  </span>
                )}
              </h2>

              <div className="btn-row">
                <div className="segmented" role="group" aria-label="Editor mode">
                  <button
                    type="button"
                    aria-pressed={mode === "edit"}
                    className={`segmented-btn ${mode === "edit" ? "active" : ""}`}
                    onClick={() => setMode("edit")}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === "preview"}
                    className={`segmented-btn ${mode === "preview" ? "active" : ""}`}
                    onClick={() => setMode("preview")}
                  >
                    Preview
                  </button>
                </div>
                <button
                  type="button"
                  data-testid="save-knowledge-btn"
                  className="btn btn-primary btn-sm"
                  disabled={saving}
                  onClick={() => void handleSave()}
                >
                  <Save size={13} aria-hidden="true" /> {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>

            {mode === "edit" ? (
              <textarea
                data-testid="knowledge-editor-textarea"
                className="textarea editor-textarea"
                aria-label={`Contents of ${selectedPath}`}
                value={content}
                onChange={(ev) => setContent(ev.target.value)}
              />
            ) : (
              <div
                className="markdown-body"
                dangerouslySetInnerHTML={{
                  __html: renderSafeMarkdownHtml(content),
                }}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
