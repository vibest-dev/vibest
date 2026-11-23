import { X } from "lucide-react"
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
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-title"
        onClick={(ev) => ev.stopPropagation()}
        data-testid="add-project-modal"
      >
        <div className="modal-head">
          <h2 className="modal-title" id="add-project-title">
            Add a project
          </h2>
          <button type="button" className="btn btn-quiet icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="segmented" role="group" aria-label="Source">
          <button
            type="button"
            data-testid="modal-tab-import"
            aria-pressed={tab === "import"}
            className={`segmented-btn ${tab === "import" ? "active" : ""}`}
            onClick={() => setTab("import")}
          >
            Import a Vibest folder
          </button>
          <button
            type="button"
            data-testid="modal-tab-create"
            aria-pressed={tab === "create"}
            className={`segmented-btn ${tab === "create" ? "active" : ""}`}
            onClick={() => setTab("create")}
          >
            Blank project
          </button>
        </div>

        {tab === "import" ? (
          <>
            <p className="help-text">
              Copies <code>preferences.md</code>, <code>memories/</code>, <code>docs/</code>, and sessions from{" "}
              <code>vibest.db</code>. The database opens read-only; nothing in the folder changes.
            </p>
            <div className="field">
              <label htmlFor="import-dir">Vibest project folder</label>
              <input
                id="import-dir"
                data-testid="import-vibest-dir-input"
                className="input"
                placeholder="/Users/you/.vibest/projects/<uuid>"
                value={vibestDir}
                onChange={(ev) => setVibestDir(ev.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="import-name">Display name (optional)</label>
              <input
                id="import-name"
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
            <div className="field">
              <label htmlFor="create-name">Project name</label>
              <input
                id="create-name"
                data-testid="create-project-name-input"
                className="input"
                placeholder="my-service"
                value={name}
                onChange={(ev) => setName(ev.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="create-description">Description</label>
              <input
                id="create-description"
                className="input"
                value={description}
                onChange={(ev) => setDescription(ev.target.value)}
              />
            </div>
          </>
        )}

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}

        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="modal-submit-project-btn"
            className="btn btn-primary"
            disabled={busy || (tab === "import" ? vibestDir.trim().length === 0 : name.trim().length === 0)}
            onClick={() => void handleSubmit()}
          >
            {busy ? "Working…" : tab === "import" ? "Import" : "Create project"}
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
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="modal-title" id="new-task-title">
            New workstream
          </h2>
          <button type="button" className="btn btn-quiet icon-btn" aria-label="Close" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="field">
          <label htmlFor="task-title">Title</label>
          <input
            id="task-title"
            className="input"
            placeholder="Implement WebSocket resume cursor"
            value={title}
            onChange={(ev) => setTitle(ev.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="task-summary">Current status</label>
          <input
            id="task-summary"
            className="input"
            placeholder="One line on where it stands"
            value={summary}
            onChange={(ev) => setSummary(ev.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="task-branch">Branch (optional)</label>
          <input
            id="task-branch"
            className="input"
            placeholder="feat/ws-cursor"
            value={branch}
            onChange={(ev) => setBranch(ev.target.value)}
          />
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || title.trim().length === 0}
            onClick={() => void handleSave()}
          >
            Create workstream
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
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-artifact-title"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="modal-title" id="new-artifact-title">
            New artifact
          </h2>
          <button type="button" className="btn btn-quiet icon-btn" aria-label="Close" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="segmented" role="group" aria-label="Kind">
          {(
            [
              ["whiteboard", "Whiteboard"],
              ["html", "HTML prototype"],
              ["markdown", "Spec"],
              ["verify", "Verify card"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              className={`segmented-btn ${kind === k ? "active" : ""}`}
              onClick={() => setKind(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="field">
          <label htmlFor="artifact-title">Title</label>
          <input id="artifact-title" className="input" value={title} onChange={(ev) => setTitle(ev.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="artifact-task">Workstream</label>
          <select id="artifact-task" className="select" value={taskId} onChange={(ev) => setTaskId(ev.target.value)}>
            <option value="">None (standalone)</option>
            {props.tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="artifact-summary">Summary</label>
          <input
            id="artifact-summary"
            className="input"
            placeholder="One line on what to review"
            value={summary}
            onChange={(ev) => setSummary(ev.target.value)}
          />
        </div>

        {kind !== "whiteboard" && (
          <div className="field">
            <label htmlFor="artifact-content">{kind === "html" ? "HTML" : "Markdown"}</label>
            <textarea
              id="artifact-content"
              className="textarea"
              value={content}
              onChange={(ev) => setContent(ev.target.value)}
            />
          </div>
        )}

        <label className="check-label">
          <input type="checkbox" checked={requestReview} onChange={(ev) => setRequestReview(ev.target.checked)} />
          Request my review now (shows in Needs you)
        </label>

        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || title.trim().length === 0}
            onClick={() => void handleSave()}
          >
            Create and open
          </button>
        </div>
      </div>
    </div>
  )
}
