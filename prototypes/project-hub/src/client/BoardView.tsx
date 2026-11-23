import { Code, GitBranch, MessageSquare, Play, Plus } from "lucide-react"
import { useState, type KeyboardEvent } from "react"

import type { ArtifactKind, BoardViewData } from "../schema.ts"
import { hubApi, type ArtifactWithCount } from "./api.ts"
import { KindLabel, ReviewStatusText, kindText } from "./labels.tsx"

function activateOnKey(action: () => void) {
  return (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault()
      action()
    }
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`
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
  const doneCount = board.doneTasks.length + board.doneStandaloneArtifacts.length

  return (
    <div className="page-scroll">
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">{board.project.name}</h1>
            <p className="page-lede">{board.project.description}</p>
          </div>
          <div className="btn-row">
            <button
              type="button"
              data-testid="toggle-session-facts-btn"
              className="btn btn-quiet"
              aria-expanded={showFacts}
              onClick={() => setShowFacts((v) => !v)}
            >
              <Code size={15} aria-hidden="true" /> Session facts
            </button>
            <button type="button" data-testid="new-task-btn" className="btn" onClick={onOpenNewTaskModal}>
              <Plus size={15} aria-hidden="true" /> New workstream
            </button>
            <button
              type="button"
              data-testid="new-artifact-btn"
              className="btn btn-primary"
              onClick={onOpenNewArtifactModal}
            >
              <Plus size={15} aria-hidden="true" /> New artifact
            </button>
          </div>
        </header>

        {showFacts && (
          <section className="facts" aria-labelledby="board-facts-title">
            <div className="facts-head">
              <h2 className="facts-title" id="board-facts-title">
                Session facts injected into every prompt
              </h2>
            </div>
            <pre className="code-block" data-testid="board-session-facts">
              {board.sessionFactsMarkdown}
            </pre>
          </section>
        )}

        <section className="section" data-testid="needs-you-section" aria-labelledby="needs-you-title">
          <div className="section-head">
            <h2 className="section-title" id="needs-you-title">
              Needs you
              <span
                className={`section-count ${board.needsYou.length > 0 ? "attention" : ""}`}
                data-testid="needs-you-count"
              >
                {board.needsYou.length}
              </span>
            </h2>
            <span className="section-note">Requested reviews and blocked sessions</span>
          </div>

          {board.needsYou.length === 0 ? (
            <p className="empty-note">Nothing is waiting on you. New review requests and blocked sessions land here.</p>
          ) : (
            <ul className="ledger">
              {board.needsYou.map((item) => {
                if (item.itemType === "artifact_review") {
                  const art = item.artifact
                  const open = () => onOpenArtifact(art.id)

                  return (
                    <li
                      key={item.id}
                      data-testid={`needs-you-card-${art.id}`}
                      className="ledger-row is-link"
                      role="link"
                      tabIndex={0}
                      onClick={open}
                      onKeyDown={activateOnKey(open)}
                    >
                      <KindLabel kind={art.kind} />
                      <div className="row-main">
                        <h3 className="row-title">{art.title}</h3>
                        <p className="row-desc">{art.summary}</p>
                        <div className="row-meta">
                          <span>{item.taskTitle ?? "Standalone"}</span>
                          <span className="mono">v{art.version}</span>
                          {item.unansweredQuestionCount > 0 && (
                            <span>{plural(item.unansweredQuestionCount, "open decision")}</span>
                          )}
                          <span>
                            <MessageSquare size={12} aria-hidden="true" /> {plural(item.openCommentCount, "comment")}
                          </span>
                        </div>
                      </div>
                      <div className="row-side">
                        <ReviewStatusText status={art.reviewStatus} />
                      </div>
                    </li>
                  )
                }

                const ses = item.session

                return (
                  <li key={item.id} data-testid={`needs-you-session-${ses.id}`} className="ledger-row">
                    <span className="row-kind">Session</span>
                    <div className="row-main">
                      <h3 className="row-title">{ses.name}</h3>
                      <p className="row-desc">{ses.blockedReason ?? "Waiting for your confirmation."}</p>
                      <div className="row-meta">
                        <span>{item.taskTitle ?? "Unassigned"}</span>
                        <span className="mono">
                          {ses.harness} · {ses.model ?? ses.agent}
                        </span>
                      </div>
                    </div>
                    <div className="row-side">
                      <span className="status status-attention">Blocked</span>
                      <button
                        type="button"
                        data-testid={`unblock-session-${ses.id}`}
                        className="btn btn-sm btn-primary"
                        onClick={async () => {
                          await hubApi.updateSessionStatus(ses.id, "running")
                          await onBoardMutated()
                        }}
                      >
                        <Play size={12} aria-hidden="true" /> Unblock and resume
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="section" data-testid="in-progress-section" aria-labelledby="in-progress-title">
          <div className="section-head">
            <h2 className="section-title" id="in-progress-title">
              In progress
              <span className="section-count">{board.inProgress.length}</span>
            </h2>
          </div>

          {board.inProgress.length === 0 && (
            <p className="empty-note">No active workstreams. Start one with New workstream.</p>
          )}

          {board.inProgress.map((lane) => (
            <article key={lane.task.id} className="stream" data-testid={`task-card-${lane.task.id}`}>
              <div className="row-main">
                <h3 className="row-title">{lane.task.title}</h3>
                <p className="row-desc">{lane.task.summary}</p>
                <div className="row-meta">
                  {lane.task.branch && (
                    <span className="mono">
                      <GitBranch size={12} aria-hidden="true" /> {lane.task.branch}
                    </span>
                  )}
                  <span>{plural(lane.sessions.length, "linked session")}</span>
                </div>
              </div>
              <div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    await hubApi.updateTask(lane.task.id, { status: "done" })
                    await onBoardMutated()
                  }}
                >
                  Mark done
                </button>
              </div>

              {lane.artifacts.length > 0 && (
                <ul className="stream-artifacts">
                  {lane.artifacts.map((art) => (
                    <li key={art.id}>
                      <button type="button" className="stream-artifact" onClick={() => onOpenArtifact(art.id)}>
                        <span className="stream-artifact-title">{art.title}</span>
                        <span className="row-kind">{kindText(art.kind)}</span>
                        <ReviewStatusText status={art.reviewStatus} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </section>

        <section className="section" data-testid="done-section" aria-labelledby="done-title">
          <div className="section-head">
            <h2 className="section-title" id="done-title">
              Done
              <span className="section-count">{doneCount}</span>
            </h2>
          </div>

          <ul className="ledger">
            {board.doneTasks.map((lane) => (
              <li key={lane.task.id} className="ledger-row is-muted">
                <span className="row-kind">Workstream</span>
                <div className="row-main">
                  <h3 className="row-title">{lane.task.title}</h3>
                  <p className="row-desc">{lane.task.summary}</p>
                  {lane.task.branch && (
                    <div className="row-meta">
                      <span className="mono">{lane.task.branch}</span>
                    </div>
                  )}
                </div>
                <div className="row-side">
                  <span className="status status-ok">Done</span>
                </div>
              </li>
            ))}

            {board.doneStandaloneArtifacts.map((art) => {
              const open = () => onOpenArtifact(art.id)

              return (
                <li
                  key={art.id}
                  className="ledger-row is-link is-muted"
                  role="link"
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={activateOnKey(open)}
                >
                  <KindLabel kind={art.kind} />
                  <div className="row-main">
                    <h3 className="row-title">{art.title}</h3>
                    <p className="row-desc">{art.summary}</p>
                  </div>
                  <div className="row-side">
                    <span className="status status-ok">Approved v{art.version}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      </div>
    </div>
  )
}

const GALLERY_FILTERS: ReadonlyArray<readonly ["all" | "requested" | ArtifactKind, string]> = [
  ["all", "All"],
  ["requested", "Needs review"],
  ["markdown", "Specs"],
  ["html", "HTML prototypes"],
  ["whiteboard", "Whiteboards"],
  ["verify", "Verify cards"],
]

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
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">Artifacts</h1>
            <p className="page-lede">
              Specs, HTML prototypes, whiteboards, and verify cards, each versioned with its review.
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={onOpenNewArtifactModal}>
            <Plus size={15} aria-hidden="true" /> New artifact
          </button>
        </header>

        <div className="filter-bar">
          <div className="segmented" role="group" aria-label="Filter artifacts">
            {GALLERY_FILTERS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                className={`segmented-btn ${filter === key ? "active" : ""}`}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th scope="col">Artifact</th>
              <th scope="col">Kind</th>
              <th scope="col">Review</th>
              <th scope="col" className="num">
                Version
              </th>
              <th scope="col" className="num">
                Open pins
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((art) => {
              const open = () => onOpenArtifact(art.id)

              return (
                <tr
                  key={art.id}
                  data-testid={`gallery-artifact-${art.id}`}
                  className="is-link"
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={activateOnKey(open)}
                >
                  <td>
                    <div className="cell-title">{art.title}</div>
                    <div className="cell-sub">{art.summary}</div>
                    <div className="cell-sub mono">{art.slug}</div>
                  </td>
                  <td>
                    <KindLabel kind={art.kind} />
                  </td>
                  <td>
                    <ReviewStatusText status={art.reviewStatus} />
                  </td>
                  <td className="num mono">v{art.version}</td>
                  <td className="num">{art.openCommentCount}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="empty-note">No artifacts match this filter.</p>}
      </div>
    </div>
  )
}
