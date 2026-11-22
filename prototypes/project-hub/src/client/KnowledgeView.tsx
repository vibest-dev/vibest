import { BookOpen, Eye, FilePlus2, Save } from "lucide-react"
import { marked } from "marked"
import { useCallback, useEffect, useState } from "react"

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
      setSavedBanner(`Saved ${selectedPath}`)
      await loadFiles()
      setTimeout(() => setSavedBanner(null), 2000)
    } finally {
      setSaving(false)
    }
  }

  const handleCreateFile = async () => {
    const cleaned = newPathInput.trim().replace(/^\/+/, "")

    if (!cleaned) return

    const targetPath =
      cleaned === "preferences.md" || cleaned.startsWith("memories/") || cleaned.startsWith("docs/")
        ? cleaned
        : `memories/${cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`}`

    await hubApi.saveKnowledgeFile(projectId, targetPath, `# ${targetPath}\n\n`)
    setNewPathInput("")
    setShowNewInput(false)
    await loadFiles()
    setSelectedPath(targetPath)
  }

  return (
    <div className="page-scroll" data-testid="knowledge-view">
      <div className="page-header">
        <div>
          <h1 className="page-title">Project Knowledge</h1>
          <p className="page-subtitle">Browse and edit isolated project preferences.md, memories/, and docs/</p>
        </div>
        <button
          type="button"
          data-testid="new-knowledge-file-btn"
          className="btn"
          onClick={() => setShowNewInput((v) => !v)}
        >
          <FilePlus2 size={14} /> New Memory / Doc
        </button>
      </div>

      {showNewInput && (
        <div className="card" style={{ marginBottom: 16, flexDirection: "row", alignItems: "center" }}>
          <input
            className="input"
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
        <div className="card" style={{ gap: 6, alignContent: "flex-start" }}>
          <div className="drawer-section-title">
            <span>Files ({files.length})</span>
          </div>
          {files.map((file) => (
            <button
              key={file.relativePath}
              type="button"
              data-testid={`knowledge-file-${file.relativePath}`}
              className={`rail-nav-btn ${selectedPath === file.relativePath ? "active" : ""}`}
              onClick={() => setSelectedPath(file.relativePath)}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{file.relativePath}</span>
              <span className="badge badge-neutral">{file.category}</span>
            </button>
          ))}
        </div>

        <div className="card" style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div className="btn-row">
              <BookOpen size={15} />
              <strong>{selectedPath}</strong>
              {savedBanner && <span className="badge badge-green">{savedBanner}</span>}
            </div>

            <div className="btn-row">
              <div className="segmented">
                <button
                  type="button"
                  className={`segmented-btn ${mode === "edit" ? "active" : ""}`}
                  onClick={() => setMode("edit")}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`segmented-btn ${mode === "preview" ? "active" : ""}`}
                  onClick={() => setMode("preview")}
                >
                  <Eye size={12} /> Preview
                </button>
              </div>
              <button
                type="button"
                data-testid="save-knowledge-btn"
                className="btn btn-primary btn-sm"
                disabled={saving}
                onClick={() => void handleSave()}
              >
                <Save size={13} /> {saving ? "Saving..." : "Save File"}
              </button>
            </div>
          </div>

          {mode === "edit" ? (
            <textarea
              data-testid="knowledge-editor-textarea"
              className="textarea"
              style={{
                flex: 1,
                minHeight: 440,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12.5,
              }}
              value={content}
              onChange={(ev) => setContent(ev.target.value)}
            />
          ) : (
            <div
              className="markdown-body"
              style={{ padding: "8px 4px" }}
              dangerouslySetInnerHTML={{
                __html: String(marked.parse(content, { async: false, gfm: true })),
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
