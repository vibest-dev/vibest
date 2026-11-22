import {
  AlertOctagon,
  CheckCircle2,
  Code,
  FileCheck2,
  FileText,
  GitBranch,
  Layout,
  MessageSquare,
  PenTool,
  Play,
  Plus,
  Sparkles,
} from "lucide-react"
import { useState } from "react"

import type { ArtifactKind, BoardViewData, ReviewStatus } from "../schema.ts"

const REVIEW_BADGE_MAP: Record<ReviewStatus, string> = {
  approved: "badge-green",
  requested: "badge-urgent",
  changes_requested: "badge-red",
  none: "badge-neutral",
}

import { hubApi, type ArtifactWithCount } from "./api.ts"

function kindBadge(kind: ArtifactKind) {
  switch (kind) {
    case "html":
      return (
        <span className="badge badge-blue">
          <Layout size={11} /> HTML Prototype
        </span>
      )
    case "whiteboard":
      return (
        <span className="badge badge-purple">
          <PenTool size={11} /> Whiteboard
        </span>
      )
    case "verify":
      return (
        <span className="badge badge-green">
          <FileCheck2 size={11} /> Verify Gate
        </span>
      )
    case "markdown":
      return (
        <span className="badge badge-neutral">
          <FileText size={11} /> Spec Doc
        </span>
      )
  }
}

export function BoardView(props: {
  board: BoardViewData
  onOpenArtifact: (artifactId: string) => void
  onOpenNewTaskModal: () => void
  onOpenNewArtifactModal: () => void
  onBoardMutated: () => Promise<void>
}) {
  const { board, onOpenArtifact, onOpenNewTaskModal, onOpenNewArtifactModal, onBoardMutated } = props
  const [showFacts, setShowFacts] = useState(false)

  return (
    <div className="page-scroll">
      <div className="page-header">
        <div>
          <h1 className="page-title">{board.project.name} — Triage Board</h1>
          <p className="page-subtitle">{board.project.description}</p>
        </div>
        <div className="btn-row">
          <button
            type="button"
            data-testid="toggle-session-facts-btn"
            className="btn"
            onClick={() => setShowFacts((v) => !v)}
          >
            <Code size={14} /> Session Facts Block
          </button>
          <button type="button" data-testid="new-task-btn" className="btn" onClick={onOpenNewTaskModal}>
            <Plus size={14} /> New Workstream
          </button>
          <button
            type="button"
            data-testid="new-artifact-btn"
            className="btn btn-primary"
            onClick={onOpenNewArtifactModal}
          >
            <Plus size={14} /> New Artifact
          </button>
        </div>
      </div>

      {showFacts && (
        <div className="card" style={{ marginBottom: 24, borderColor: "var(--accent-blue)" }}>
          <div className="drawer-section-title">
            <span>Compaction-Proof Session Facts Injection Preview</span>
          </div>
          <pre className="code-block" data-testid="board-session-facts" style={{ margin: 0 }}>
            {board.sessionFactsMarkdown}
          </pre>
        </div>
      )}

      <section className="board-section" data-testid="needs-you-section">
        <div className="board-section-header">
          <div className="board-section-title">
            <Sparkles size={14} color="#f59e0b" />
            <span>Needs You</span>
            <span className="badge badge-urgent" data-testid="needs-you-count">
              {board.needsYou.length}
            </span>
          </div>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Derived strictly from Artifact(review=requested) + Session(status=blocked)
          </span>
        </div>

        {board.needsYou.length === 0 ? (
          <div className="card" style={{ alignItems: "center", padding: 24, color: "var(--text-secondary)" }}>
            <CheckCircle2 size={22} color="#10b981" />
            <div>All clear — zero pending review gates or blocked sessions.</div>
          </div>
        ) : (
          <div className="cards-grid">
            {board.needsYou.map((item) => {
              if (item.itemType === "artifact_review") {
                const art = item.artifact

                return (
                  <div
                    key={item.id}
                    data-testid={`needs-you-card-${art.id}`}
                    className="card card-clickable card-urgent"
                    onClick={() => onOpenArtifact(art.id)}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      {kindBadge(art.kind)}
                      <span className="badge badge-urgent">v{art.version} · Review Requested</span>
                    </div>
                    <h3 className="card-title">{art.title}</h3>
                    <p className="card-desc">{art.summary}</p>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginTop: "auto",
                        paddingTop: 6,
                        fontSize: 12,
                        color: "var(--text-secondary)",
                      }}
                    >
                      <span>{item.taskTitle ?? "Standalone Deliverable"}</span>
                      <div className="btn-row">
                        {item.unansweredQuestionCount > 0 && (
                          <span className="badge badge-purple">{item.unansweredQuestionCount} decision(s)</span>
                        )}
                        <span className="badge badge-neutral">
                          <MessageSquare size={11} /> {item.openCommentCount}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              }

              const ses = item.session

              return (
                <div key={item.id} data-testid={`needs-you-session-${ses.id}`} className="card card-blocked">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span className="badge badge-red">
                      <AlertOctagon size={11} /> Blocked Session
                    </span>
                    <span className="badge badge-neutral">
                      {ses.harness} · {ses.model ?? ses.agent}
                    </span>
                  </div>
                  <h3 className="card-title">{ses.name}</h3>
                  <p className="card-desc">{ses.blockedReason ?? "Session awaiting user confirmation"}</p>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginTop: "auto",
                    }}
                  >
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{item.taskTitle ?? ses.id}</span>
                    <button
                      type="button"
                      data-testid={`unblock-session-${ses.id}`}
                      className="btn btn-sm btn-primary"
                      onClick={async () => {
                        await hubApi.updateSessionStatus(ses.id, "running")
                        await onBoardMutated()
                      }}
                    >
                      <Play size={12} /> Unblock &amp; Resume
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="board-section" data-testid="in-progress-section">
        <div className="board-section-header">
          <div className="board-section-title">
            <span>In Progress Workstreams</span>
            <span className="badge badge-blue">{board.inProgress.length}</span>
          </div>
        </div>

        <div className="cards-grid">
          {board.inProgress.map((lane) => (
            <div key={lane.task.id} className="card" data-testid={`task-card-${lane.task.id}`}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div className="btn-row">
                  {lane.task.branch && (
                    <span className="badge badge-neutral">
                      <GitBranch size={11} /> {lane.task.branch}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    await hubApi.updateTask(lane.task.id, { status: "done" })
                    await onBoardMutated()
                  }}
                >
                  Mark Done
                </button>
              </div>
              <h3 className="card-title">{lane.task.title}</h3>
              <p className="card-desc">{lane.task.summary}</p>

              {lane.artifacts.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 4 }}>
                  {lane.artifacts.map((art) => (
                    <button
                      key={art.id}
                      type="button"
                      className="option-choice"
                      style={{ justifyContent: "space-between", padding: "6px 9px" }}
                      onClick={() => onOpenArtifact(art.id)}
                    >
                      <span style={{ fontWeight: 600, fontSize: 12 }}>{art.title}</span>
                      <span className={`badge ${REVIEW_BADGE_MAP[art.reviewStatus]}`}>
                        {art.kind} · {art.reviewStatus}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: "auto" }}>
                {lane.sessions.length} linked session(s)
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="board-section" data-testid="done-section">
        <div className="board-section-header">
          <div className="board-section-title">
            <span>Done &amp; Approved</span>
            <span className="badge badge-green">{board.doneTasks.length + board.doneStandaloneArtifacts.length}</span>
          </div>
        </div>

        <div className="cards-grid">
          {board.doneTasks.map((lane) => (
            <div key={lane.task.id} className="card" style={{ opacity: 0.88 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="badge badge-green">Task Done</span>
                {lane.task.branch && <span className="badge badge-neutral">{lane.task.branch}</span>}
              </div>
              <h3 className="card-title">{lane.task.title}</h3>
              <p className="card-desc">{lane.task.summary}</p>
            </div>
          ))}

          {board.doneStandaloneArtifacts.map((art) => (
            <div
              key={art.id}
              className="card card-clickable"
              style={{ opacity: 0.9 }}
              onClick={() => onOpenArtifact(art.id)}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                {kindBadge(art.kind)}
                <span className="badge badge-green">Approved v{art.version}</span>
              </div>
              <h3 className="card-title">{art.title}</h3>
              <p className="card-desc">{art.summary}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

export function ArtifactsGalleryView(props: {
  artifacts: ArtifactWithCount[]
  onOpenArtifact: (artifactId: string) => void
  onOpenNewArtifactModal: () => void
}) {
  const { artifacts, onOpenArtifact, onOpenNewArtifactModal } = props
  const [filter, setFilter] = useState<"all" | "requested" | ArtifactKind>("all")

  const filtered = artifacts.flatMap((a) => {
    if (filter === "all") return [a]

    if (filter === "requested") return a.reviewStatus === "requested" ? [a] : []

    return a.kind === filter ? [a] : []
  })

  return (
    <div className="page-scroll">
      <div className="page-header">
        <div>
          <h1 className="page-title">Artifacts Studio</h1>
          <p className="page-subtitle">
            Versioned specs, multi-variant HTML prototypes, Excalidraw whiteboards, and PR verify gates
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onOpenNewArtifactModal}>
          <Plus size={14} /> New Artifact
        </button>
      </div>

      <div style={{ marginBottom: 18 }}>
        <div className="segmented">
          {(
            [
              ["all", "All"],
              ["requested", "Needs Review"],
              ["markdown", "Specs"],
              ["html", "HTML Prototypes"],
              ["whiteboard", "Whiteboards"],
              ["verify", "Verify Cards"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`segmented-btn ${filter === key ? "active" : ""}`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="cards-grid">
        {filtered.map((art) => (
          <div
            key={art.id}
            data-testid={`gallery-artifact-${art.id}`}
            className={`card card-clickable ${art.reviewStatus === "requested" ? "card-urgent" : ""}`}
            onClick={() => onOpenArtifact(art.id)}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              {kindBadge(art.kind)}
              <span className={`badge ${REVIEW_BADGE_MAP[art.reviewStatus]}`}>
                v{art.version} · {art.reviewStatus}
              </span>
            </div>
            <h3 className="card-title">{art.title}</h3>
            <p className="card-desc">{art.summary}</p>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: "auto",
                fontSize: 12,
                color: "var(--text-secondary)",
              }}
            >
              <code>{art.slug}</code>
              <span>{art.openCommentCount} open pin(s)</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
