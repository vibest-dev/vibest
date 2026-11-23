import { ArrowLeft, Check, CheckCircle2, Code2, Copy, GitPullRequest, RotateCcw, Send, XCircle } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import type { CommentAnchor, CommentThread, ReviewVerdict } from "../schema.ts"
import { hubApi, type ArtifactDetailResponse } from "./api.ts"
import { HtmlAnnotator, type HtmlAnnotationMode } from "./HtmlAnnotator.tsx"
import { ReviewStatusText } from "./labels.tsx"
import { MarkdownViewer } from "./MarkdownViewer.tsx"
import { VerifyCardView } from "./VerifyCardView.tsx"
import { WhiteboardStage } from "./WhiteboardStage.tsx"

function describeAnchorChip(anchor: CommentAnchor): string {
  switch (anchor.kind) {
    case "dom":
      return `${anchor.variantId} · ${anchor.tagName}${anchor.selector.startsWith("#") ? "" : " "}${anchor.selector}`
    case "region":
      return `${anchor.variantId} · ${anchor.regionStyle} at ${Math.round(anchor.xRatio * 100)}%, ${Math.round(anchor.yRatio * 100)}%`
    case "whiteboard":
      return `Whiteboard · ${anchor.elementLabels.join(", ") || anchor.elementIds.join(", ")}`
    case "quote":
      return `Quote "${anchor.quote.slice(0, 44)}${anchor.quote.length > 44 ? "…" : ""}"`
    case "verify":
      return `Gate · ${anchor.section}`
  }
}

export function ArtifactStudio(props: {
  artifactId: string
  refreshSignal: number
  onBack: () => void
  onReviewSubmitted: () => void
}) {
  const { artifactId, refreshSignal, onBack, onReviewSubmitted } = props

  const [detail, setDetail] = useState<ArtifactDetailResponse | null>(null)
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(undefined)
  const [selectedVariantId, setSelectedVariantId] = useState<string | undefined>(undefined)
  const [htmlMode, setHtmlMode] = useState<HtmlAnnotationMode>("pick")
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [showPayloadDrawer, setShowPayloadDrawer] = useState(false)
  const [reviewerNote, setReviewerNote] = useState("")
  const [optInVibestSend, setOptInVibestSend] = useState(false)
  const [copiedPayload, setCopiedPayload] = useState(false)
  const [verdictFeedback, setVerdictFeedback] = useState<string | null>(null)
  const [submittingVerdict, setSubmittingVerdict] = useState(false)

  useEffect(() => {
    setSelectedVersion(undefined)
    setSelectedVariantId(undefined)
    setActiveThreadId(null)
    setVerdictFeedback(null)
  }, [artifactId])

  const loadDetail = useCallback(async () => {
    try {
      const data = await hubApi.getArtifactDetail(artifactId, selectedVersion, selectedVariantId)
      setDetail(data)

      if (!selectedVariantId && data.artifact.metadata.selectedVariantId) {
        setSelectedVariantId(data.artifact.metadata.selectedVariantId)
      } else if (!selectedVariantId && data.artifact.metadata.variants?.[0]) {
        setSelectedVariantId(data.artifact.metadata.variants[0].id)
      }
    } catch {
      onBack()
    }
  }, [artifactId, onBack, selectedVersion, selectedVariantId])

  useEffect(() => {
    void loadDetail()
  }, [loadDetail, refreshSignal])

  if (!detail) {
    return (
      <div className="page-scroll">
        <p className="muted-note">Loading artifact…</p>
      </div>
    )
  }

  const { artifact, content, threads, agentPayloadPreview, targetSessionId } = detail
  const variants = artifact.metadata.variants ?? []

  const currentVariant = selectedVariantId ?? artifact.metadata.selectedVariantId ?? variants[0]?.id ?? "default"

  const handleCreateComment = async (body: string, anchor: CommentAnchor) => {
    const created = await hubApi.addComment(artifact.id, { body, anchor })
    setActiveThreadId(created.thread.id)
    await loadDetail()
  }

  const handleToggleOption = async (questionId: string, optionId: string, multiSelect: boolean) => {
    const current = artifact.answers[questionId] ?? []

    const next = multiSelect
      ? current.includes(optionId)
        ? current.flatMap((id) => (id === optionId ? [] : [id]))
        : [...current, optionId]
      : [optionId]

    await hubApi.answerQuestion(artifact.id, questionId, next)
    await loadDetail()
  }

  const handleSelectThread = (thread: CommentThread) => {
    setActiveThreadId(thread.id)

    if (
      (thread.anchor.kind === "dom" || thread.anchor.kind === "region") &&
      thread.anchor.variantId !== currentVariant
    ) {
      setSelectedVariantId(thread.anchor.variantId)
    }
  }

  const handleReplySubmit = async (threadId: string) => {
    const text = (replyDrafts[threadId] ?? "").trim()

    if (!text) return
    await hubApi.replyComment(threadId, text)
    setReplyDrafts((prev) => ({ ...prev, [threadId]: "" }))
    await loadDetail()
  }

  const handleVerdict = async (verdict: ReviewVerdict) => {
    setSubmittingVerdict(true)

    try {
      const res = await hubApi.submitReview(artifact.id, {
        verdict,
        ...(reviewerNote.trim().length > 0 && { reviewerNote: reviewerNote.trim() }),
        deliverViaVibestSend: optInVibestSend,
      })

      setDetail((prev) =>
        prev
          ? {
              ...prev,
              artifact: res.artifact,
              agentPayloadPreview: res.agentPayload,
            }
          : prev,
      )
      setShowPayloadDrawer(true)
      setVerdictFeedback(
        verdict === "approved"
          ? `Approved v${res.artifact.version}. It left Needs you and the agent payload is ready.`
          : `Requested changes on v${res.artifact.version}. Routed to ${res.targetSessionId ?? "the author"}.`,
      )
      onReviewSubmitted()
    } finally {
      setSubmittingVerdict(false)
    }
  }

  const openThreadsCount = threads.flatMap((t) => (t.resolved ? [] : [t])).length

  return (
    <div className="studio-shell">
      <header className="studio-topbar">
        <div className="studio-heading">
          <button type="button" data-testid="studio-back-btn" className="btn btn-quiet btn-sm" onClick={onBack}>
            <ArrowLeft size={14} aria-hidden="true" /> Board
          </button>
          <h1 className="studio-title">{artifact.title}</h1>
          <span className="mono studio-version">v{selectedVersion ?? artifact.version}</span>
          <ReviewStatusText status={artifact.reviewStatus} testId="studio-review-status" />
        </div>

        <div className="btn-row">
          {artifact.versions.length > 1 && (
            <select
              className="select status-select"
              aria-label="Version"
              value={selectedVersion ?? artifact.version}
              onChange={(ev) => setSelectedVersion(Number(ev.target.value))}
            >
              {artifact.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  Version {v.version}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            data-testid="toggle-agent-payload-btn"
            className="btn btn-quiet"
            aria-expanded={showPayloadDrawer}
            onClick={() => setShowPayloadDrawer((v) => !v)}
          >
            <Code2 size={15} aria-hidden="true" /> Agent payload
          </button>

          <button
            type="button"
            data-testid="verdict-request-changes-btn"
            className="btn btn-outline"
            disabled={submittingVerdict}
            onClick={() => void handleVerdict("changes_requested")}
          >
            <XCircle size={15} aria-hidden="true" /> Request changes
          </button>

          <button
            type="button"
            data-testid="verdict-approve-btn"
            className="btn btn-primary"
            disabled={submittingVerdict}
            onClick={() => void handleVerdict("approved")}
          >
            <CheckCircle2 size={15} aria-hidden="true" /> Approve
          </button>
        </div>
      </header>

      {variants.length > 0 && (
        <div className="studio-subbar">
          <span className="subbar-label">Variant</span>
          <div className="segmented" role="group" aria-label="Variant">
            {variants.map((variant) => (
              <button
                key={variant.id}
                type="button"
                data-testid={`variant-tab-${variant.id}`}
                aria-pressed={currentVariant === variant.id}
                className={`segmented-btn ${currentVariant === variant.id ? "active" : ""}`}
                onClick={() => {
                  setSelectedVariantId(variant.id)
                  void hubApi.selectVariant(artifact.id, variant.id)
                }}
              >
                {variant.label}
              </button>
            ))}
          </div>
          <span className="subbar-note">{variants.find((v) => v.id === currentVariant)?.description}</span>
        </div>
      )}

      {verdictFeedback && (
        <div data-testid="verdict-feedback-banner" className="banner" role="status">
          <span>{verdictFeedback}</span>
          <button type="button" className="btn btn-sm" onClick={() => setVerdictFeedback(null)}>
            Dismiss
          </button>
        </div>
      )}

      {showPayloadDrawer && (
        <div data-testid="agent-payload-drawer" className="payload-drawer">
          <div className="payload-bar">
            <div className="btn-row">
              <span className="payload-target">
                <GitPullRequest size={13} aria-hidden="true" /> Goes to{" "}
                <span className="mono">{targetSessionId ?? "entry-session"}</span>
              </span>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={optInVibestSend}
                  onChange={(ev) => setOptInVibestSend(ev.target.checked)}
                />
                Deliver live with <code>vibest send</code> on verdict
              </label>
            </div>

            <button
              type="button"
              data-testid="copy-agent-payload-btn"
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(agentPayloadPreview)
                setCopiedPayload(true)
                setTimeout(() => setCopiedPayload(false), 1500)
              }}
            >
              <Copy size={12} aria-hidden="true" /> {copiedPayload ? "Copied" : "Copy payload"}
            </button>
          </div>
          <pre className="code-block" data-testid="agent-payload-xml">
            {agentPayloadPreview}
          </pre>
        </div>
      )}

      <div className="studio-body">
        <div className="studio-stage">
          {artifact.kind === "html" && (
            <HtmlAnnotator
              artifact={artifact}
              version={selectedVersion ?? artifact.version}
              variantId={currentVariant}
              mode={htmlMode}
              onModeChange={setHtmlMode}
              threads={threads}
              activeThreadId={activeThreadId}
              onSelectThread={setActiveThreadId}
              onCreateComment={handleCreateComment}
            />
          )}

          {artifact.kind === "whiteboard" && (
            <WhiteboardStage
              artifact={artifact}
              initialContent={content}
              threads={threads}
              activeThreadId={activeThreadId}
              onCreateComment={handleCreateComment}
              onReloadRequested={loadDetail}
            />
          )}

          {artifact.kind === "markdown" && (
            <MarkdownViewer
              content={content}
              threads={threads}
              activeThreadId={activeThreadId}
              onSelectThread={setActiveThreadId}
              onCreateComment={handleCreateComment}
            />
          )}

          {artifact.kind === "verify" && (
            <VerifyCardView artifact={artifact} content={content} onCreateComment={handleCreateComment} />
          )}
        </div>

        <aside className="studio-drawer" aria-label="Review">
          <section className="drawer-section">
            <h2 className="drawer-heading">
              <label htmlFor="verdict-note">Verdict note</label>
            </h2>
            <input
              id="verdict-note"
              className="input"
              placeholder="Optional guidance sent with the verdict"
              value={reviewerNote}
              onChange={(ev) => setReviewerNote(ev.target.value)}
            />
          </section>

          {artifact.questions.length > 0 && (
            <section className="drawer-section" data-testid="questions-section">
              <h2 className="drawer-heading">
                Decisions
                <span className="section-count">{artifact.questions.length}</span>
              </h2>

              {artifact.questions.map((q) => {
                const chosen = artifact.answers[q.id] ?? []

                return (
                  <div key={q.id} className="question" data-testid={`question-${q.id}`}>
                    <h3 className="question-title">{q.question}</h3>
                    {q.context && <p className="question-context">{q.context}</p>}
                    <div className="option-list" role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question}>
                      {q.options.map((opt) => {
                        const isPicked = chosen.includes(opt.id)

                        return (
                          <button
                            key={opt.id}
                            type="button"
                            role={q.multiSelect ? "checkbox" : "radio"}
                            aria-checked={isPicked}
                            data-testid={`option-${q.id}-${opt.id}`}
                            className={`option-choice ${isPicked ? "selected" : ""}`}
                            onClick={() => void handleToggleOption(q.id, opt.id, q.multiSelect)}
                          >
                            <span className={`option-mark ${q.multiSelect ? "is-multi" : ""}`}>
                              {isPicked && <Check size={11} strokeWidth={3} aria-hidden="true" />}
                            </span>
                            <span className="option-body">
                              <span className="option-label">{opt.label}</span>
                              {opt.description && <span className="option-note">{opt.description}</span>}
                              {opt.recommended && <span className="option-recommended">Recommended</span>}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </section>
          )}

          <section className="drawer-section" data-testid="threads-section">
            <h2 className="drawer-heading">
              Comments
              <span className="section-count">
                {openThreadsCount} open of {threads.length}
              </span>
            </h2>

            {threads.length === 0 && (
              <p className="muted-note">
                No comments yet. Pick an element, draw a region, select a whiteboard shape, or highlight spec text.
              </p>
            )}

            <div className="thread-list">
              {threads.map((thread) => {
                const isSelected = activeThreadId === thread.id

                return (
                  <article
                    key={thread.id}
                    data-testid={`drawer-thread-${thread.pinNumber}`}
                    className={`thread-item ${isSelected ? "active" : ""} ${thread.resolved ? "resolved" : ""}`}
                    onClick={() => handleSelectThread(thread)}
                  >
                    <div className="thread-head">
                      <span className="thread-who">
                        <span className="pin-badge">{thread.pinNumber}</span>
                        {thread.author}
                      </span>
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          void hubApi.setCommentResolved(thread.id, !thread.resolved).then(() => loadDetail())
                        }}
                      >
                        {thread.resolved ? (
                          <RotateCcw size={12} aria-hidden="true" />
                        ) : (
                          <Check size={12} aria-hidden="true" />
                        )}
                        {thread.resolved ? "Reopen" : "Resolve"}
                      </button>
                    </div>

                    <div className="thread-anchor-chip">{describeAnchorChip(thread.anchor)}</div>

                    <div className="thread-body">{thread.body}</div>

                    {thread.replies.length > 0 && (
                      <div className="thread-replies">
                        {thread.replies.map((r) => (
                          <div key={r.id}>
                            <strong>{r.author}</strong> {r.body}
                          </div>
                        ))}
                      </div>
                    )}

                    {isSelected && (
                      <div className="reply-row" onClick={(ev) => ev.stopPropagation()}>
                        <input
                          className="input"
                          aria-label="Reply"
                          placeholder="Reply"
                          value={replyDrafts[thread.id] ?? ""}
                          onChange={(ev) => setReplyDrafts((prev) => ({ ...prev, [thread.id]: ev.target.value }))}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter") void handleReplySubmit(thread.id)
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          aria-label="Send reply"
                          onClick={() => void handleReplySubmit(thread.id)}
                        >
                          <Send size={13} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
