import { FolderInput, Plus, X } from "lucide-react"
import { useState } from "react"

import type { ArtifactKind, Project, Task } from "../schema.ts"
import { hubApi } from "./api.ts"

export function AddProjectModal(props: {
  detectedVibestDir: string | null
  onClose: () => void
  onCreated: (project: Project) => void
}) {
  const { detectedVibestDir, onClose, onCreated } = props
  const [tab, setTab] = useState<"create" | "import">(detectedVibestDir ? "import" : "create")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("Parallel multi-agent workspace")
  const [vibestDir, setVibestDir] = useState(detectedVibestDir ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    setBusy(true)
    setError(null)

    try {
      if (tab === "import") {
        const res = await hubApi.importVibestProject({
          ...(name.trim().length > 0 && { name: name.trim() }),
          vibestProjectDir: vibestDir.trim(),
        })

        onCreated(res.project)
      } else {
        const res = await hubApi.createProject({
          name: name.trim(),
          description: description.trim(),
        })

        onCreated(res.project)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add project")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(ev) => ev.stopPropagation()} data-testid="add-project-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong style={{ fontSize: 16 }}>Add or Import Vibest Project</strong>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="segmented">
          <button
            type="button"
            data-testid="modal-tab-import"
            className={`segmented-btn ${tab === "import" ? "active" : ""}`}
            onClick={() => setTab("import")}
          >
            <FolderInput size={13} /> Read-Only Import Vibest Folder
          </button>
          <button
            type="button"
            data-testid="modal-tab-create"
            className={`segmented-btn ${tab === "create" ? "active" : ""}`}
            onClick={() => setTab("create")}
          >
            <Plus size={13} /> Blank Project
          </button>
        </div>

        {tab === "import" ? (
          <>
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
              Safely snapshots <code>preferences.md</code>, <code>memories/</code>, <code>docs/</code>, and live
              sessions from <code>vibest.db</code> using <code>readonly: true</code> without modifying external files.
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600 }}>Vibest Project Directory</label>
              <input
                data-testid="import-vibest-dir-input"
                className="input"
                placeholder="/Users/.../.vibest/projects/<uuid>"
                value={vibestDir}
                onChange={(ev) => setVibestDir(ev.target.value)}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600 }}>Display Name (Optional)</label>
              <input
                data-testid="import-project-name-input"
                className="input"
                placeholder="vibest-live-snapshot"
                value={name}
                onChange={(ev) => setName(ev.target.value)}
              />
            </div>
          </>
        ) : (
          <>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600 }}>Project Name</label>
              <input
                data-testid="create-project-name-input"
                className="input"
                placeholder="my-service"
                value={name}
                onChange={(ev) => setName(ev.target.value)}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600 }}>Description</label>
              <input className="input" value={description} onChange={(ev) => setDescription(ev.target.value)} />
            </div>
          </>
        )}

        {error && <div style={{ color: "var(--accent-red)", fontSize: 12.5 }}>{error}</div>}

        <div className="btn-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="modal-submit-project-btn"
            className="btn btn-primary"
            disabled={busy || (tab === "import" ? vibestDir.trim().length === 0 : name.trim().length === 0)}
            onClick={() => void handleSubmit()}
          >
            {busy ? "Working..." : tab === "import" ? "Import Snapshot" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  )
}

export function NewTaskModal(props: { projectId: string; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("")
  const [summary, setSummary] = useState("")
  const [branch, setBranch] = useState("")
  const [busy, setBusy] = useState(false)

  const handleSave = async () => {
    if (!title.trim()) return
    setBusy(true)

    try {
      await hubApi.createTask({
        projectId: props.projectId,
        title: title.trim(),
        summary: summary.trim() || "Workstream started",
        ...(branch.trim().length > 0 && { branch: branch.trim() }),
      })
      props.onCreated()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal-card" onClick={(ev) => ev.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong style={{ fontSize: 16 }}>New Parallel Workstream Task</strong>
          <button type="button" className="btn btn-sm" onClick={props.onClose}>
            <X size={14} />
          </button>
        </div>
        <input
          className="input"
          placeholder="Task title (e.g., Implement WebSocket Resume Cursor)"
          value={title}
          onChange={(ev) => setTitle(ev.target.value)}
        />
        <input
          className="input"
          placeholder="1-line current status summary"
          value={summary}
          onChange={(ev) => setSummary(ev.target.value)}
        />
        <input
          className="input"
          placeholder="Git branch (optional, e.g., feat/ws-cursor)"
          value={branch}
          onChange={(ev) => setBranch(ev.target.value)}
        />
        <div className="btn-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || title.trim().length === 0}
            onClick={() => void handleSave()}
          >
            Create Task
          </button>
        </div>
      </div>
    </div>
  )
}

export function NewArtifactModal(props: {
  projectId: string
  tasks: Task[]
  onClose: () => void
  onCreated: (artifactId: string) => void
}) {
  const [title, setTitle] = useState("")
  const [kind, setKind] = useState<ArtifactKind>("whiteboard")
  const [taskId, setTaskId] = useState<string>("")
  const [summary, setSummary] = useState("")
  const [content, setContent] = useState("")
  const [requestReview, setRequestReview] = useState(true)
  const [busy, setBusy] = useState(false)

  const handleSave = async () => {
    if (!title.trim()) return
    setBusy(true)

    try {
      const defaultBody =
        content.trim().length > 0
          ? content
          : kind === "html"
            ? "<div style='padding:32px;font-family:sans-serif;'><h1>Interactive Prototype</h1><button id='cta'>Click Action</button></div>"
            : kind === "markdown" || kind === "verify"
              ? `# ${title.trim()}\n\nDraft deliverable ready for review.\n`
              : ""

      const res = await hubApi.createArtifact({
        projectId: props.projectId,
        ...(taskId.length > 0 && { taskId }),
        title: title.trim(),
        kind,
        summary: summary.trim() || `Created ${kind} deliverable`,
        content: defaultBody,
        reviewStatus: requestReview ? "requested" : "none",
      })

      props.onCreated(res.artifact.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal-card" onClick={(ev) => ev.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong style={{ fontSize: 16 }}>Create Deliverable Artifact</strong>
          <button type="button" className="btn btn-sm" onClick={props.onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="segmented">
          {(
            [
              ["whiteboard", "Excalidraw 画图"],
              ["html", "HTML Prototype"],
              ["markdown", "Markdown Spec"],
              ["verify", "Verify Card"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`segmented-btn ${kind === k ? "active" : ""}`}
              onClick={() => setKind(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <input
          className="input"
          placeholder="Artifact title"
          value={title}
          onChange={(ev) => setTitle(ev.target.value)}
        />

        <select className="input" value={taskId} onChange={(ev) => setTaskId(ev.target.value)}>
          <option value="">Standalone (no linked Task)</option>
          {props.tasks.map((t) => (
            <option key={t.id} value={t.id}>
              Task: {t.title}
            </option>
          ))}
        </select>

        <input
          className="input"
          placeholder="1-line summary"
          value={summary}
          onChange={(ev) => setSummary(ev.target.value)}
        />

        {kind !== "whiteboard" && (
          <textarea
            className="textarea"
            placeholder={kind === "html" ? "Paste HTML markup..." : "Markdown content..."}
            value={content}
            onChange={(ev) => setContent(ev.target.value)}
          />
        )}

        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
          <input type="checkbox" checked={requestReview} onChange={(ev) => setRequestReview(ev.target.checked)} />
          Request owner review immediately (appears in Needs You)
        </label>

        <div className="btn-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || title.trim().length === 0}
            onClick={() => void handleSave()}
          >
            Create &amp; Open
          </button>
        </div>
      </div>
    </div>
  )
}
