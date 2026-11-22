import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Code2,
  Copy,
  GitPullRequest,
  MessageSquare,
  RotateCcw,
  Send,
  Sparkles,
  XCircle,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import type { CommentAnchor, CommentThread, ReviewStatus, ReviewVerdict } from "../schema.ts"

const STUDIO_BADGE_MAP: Record<ReviewStatus, string> = {
  approved: "badge-green",
  requested: "badge-urgent",
  changes_requested: "badge-red",
  none: "badge-neutral",
}

import { hubApi, type ArtifactDetailResponse } from "./api.ts"
import { HtmlAnnotator, type HtmlAnnotationMode } from "./HtmlAnnotator.tsx"
import { MarkdownViewer } from "./MarkdownViewer.tsx"
import { VerifyCardView } from "./VerifyCardView.tsx"
import { WhiteboardStage } from "./WhiteboardStage.tsx"

function describeAnchorChip(anchor: CommentAnchor): string {
  switch (anchor.kind) {
    case "dom":
      return `DOM [${anchor.variantId}] ${anchor.tagName}${anchor.selector}`
    case "region":
      return `Region [${anchor.variantId}] ${anchor.regionStyle} (${Math.round(anchor.xRatio * 100)}%, ${Math.round(anchor.yRatio * 100)}%)`
    case "whiteboard":
      return `Excalidraw [${anchor.elementLabels.join(", ") || anchor.elementIds.join(", ")}]`
    case "quote":
      return `Quote "${anchor.quote.slice(0, 44)}${anchor.quote.length > 44 ? "…" : ""}"`
    case "verify":
      return `Verify Gate: ${anchor.section}`
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

  const loadDetail = useCallback(async () => {
    const data = await hubApi.getArtifactDetail(artifactId, selectedVersion, selectedVariantId)
    setDetail(data)

    if (!selectedVariantId && data.artifact.metadata.selectedVariantId) {
      setSelectedVariantId(data.artifact.metadata.selectedVariantId)
    } else if (!selectedVariantId && data.artifact.metadata.variants?.[0]) {
      setSelectedVariantId(data.artifact.metadata.variants[0].id)
    }
  }, [artifactId, selectedVersion, selectedVariantId])

  useEffect(() => {
    void loadDetail()
  }, [loadDetail, refreshSignal])

  if (!detail) {
    return (
      <div className="page-scroll">
        <p style={{ color: "var(--text-secondary)" }}>Loading artifact studio...</p>
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
          ? `Approved v${res.artifact.version} — removed from Needs You and generated agent payload.`
          : `Requested changes on v${res.artifact.version} — routed to ${res.targetSessionId ?? "author"}.`,
      )
      onReviewSubmitted()
    } finally {
      setSubmittingVerdict(false)
    }
  }

  const openThreadsCount = threads.flatMap((t) => (t.resolved ? [] : [t])).length

  return (
    <div className="studio-shell">
      <div className="studio-topbar">
        <div className="btn-row">
          <button type="button" data-testid="studio-back-btn" className="btn btn-sm" onClick={onBack}>
            <ArrowLeft size={14} /> Board
          </button>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{artifact.title}</span>
          <span className="badge badge-neutral">v{selectedVersion ?? artifact.version}</span>
          <span data-testid="studio-review-status" className={`badge ${STUDIO_BADGE_MAP[artifact.reviewStatus]}`}>
            {artifact.reviewStatus.replace("_", " ")}
          </span>
        </div>

        <div className="btn-row">
          {artifact.versions.length > 1 && (
            <select
              className="input"
              style={{ width: 110, padding: "4px 8px" }}
              value={selectedVersion ?? artifact.version}
              onChange={(ev) => setSelectedVersion(Number(ev.target.value))}
            >
              {artifact.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  Version v{v.version}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            data-testid="toggle-agent-payload-btn"
            className="btn btn-sm"
            onClick={() => setShowPayloadDrawer((v) => !v)}
          >
            <Code2 size={13} /> Agent Payload
          </button>

          <button
            type="button"
            data-testid="verdict-request-changes-btn"
            className="btn btn-changes"
            disabled={submittingVerdict}
            onClick={() => void handleVerdict("changes_requested")}
          >
            <XCircle size={14} /> Request Changes
          </button>

          <button
            type="button"
            data-testid="verdict-approve-btn"
            className="btn btn-approve"
            disabled={submittingVerdict}
            onClick={() => void handleVerdict("approved")}
          >
            <CheckCircle2 size={14} /> Approve
          </button>
        </div>
      </div>

      {variants.length > 0 && (
        <div className="studio-subbar">
          <div className="btn-row">
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)" }}>Compare Variants:</span>
            <div className="segmented">
              {variants.map((variant) => (
                <button
                  key={variant.id}
                  type="button"
                  data-testid={`variant-tab-${variant.id}`}
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
          </div>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {variants.find((v) => v.id === currentVariant)?.description}
          </span>
        </div>
      )}

      {verdictFeedback && (
        <div
          data-testid="verdict-feedback-banner"
          style={{
            padding: "8px 18px",
            background: "var(--accent-green-soft)",
            borderBottom: "1px solid rgba(16, 185, 129, 0.35)",
            color: "var(--accent-green)",
            fontSize: 12.5,
            fontWeight: 600,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{verdictFeedback}</span>
          <button type="button" className="btn btn-sm" onClick={() => setVerdictFeedback(null)}>
            Dismiss
          </button>
        </div>
      )}

      {showPayloadDrawer && (
        <div
          data-testid="agent-payload-drawer"
          style={{
            padding: "12px 18px",
            background: "var(--bg-surface)",
            borderBottom: "1px solid var(--border-strong)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            maxHeight: 230,
            overflowY: "auto",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div className="btn-row">
              <span className="badge badge-purple">
                <GitPullRequest size={11} /> Target Session: {targetSessionId ?? "entry-session"}
              </span>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={optInVibestSend}
                  onChange={(ev) => setOptInVibestSend(ev.target.checked)}
                />
                Deliver live via <code>vibest send</code> on verdict
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
              <Copy size={12} /> {copiedPayload ? "Copied XML!" : "Copy <vibest-artifact-review>"}
            </button>
          </div>
          <pre className="code-block" data-testid="agent-payload-xml" style={{ margin: 0 }}>
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

        <aside className="studio-drawer">
          <div className="drawer-section">
            <div className="drawer-section-title">
              <span>Summary Verdict Note (Optional)</span>
            </div>
            <input
              className="input"
              placeholder="High-level guidance included with verdict..."
              value={reviewerNote}
              onChange={(ev) => setReviewerNote(ev.target.value)}
            />
          </div>

          {artifact.questions.length > 0 && (
            <div className="drawer-section" data-testid="questions-section">
              <div className="drawer-section-title">
                <span>Decisions Required ({artifact.questions.length})</span>
                <Sparkles size={13} />
              </div>

              {artifact.questions.map((q) => {
                const chosen = artifact.answers[q.id] ?? []

                return (
                  <div key={q.id} className="question-box" data-testid={`question-${q.id}`}>
                    <div style={{ fontWeight: 650, fontSize: 13 }}>{q.question}</div>
                    {q.context && <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{q.context}</div>}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {q.options.map((opt) => {
                        const isPicked = chosen.includes(opt.id)

                        return (
                          <button
                            key={opt.id}
                            type="button"
                            data-testid={`option-${q.id}-${opt.id}`}
                            className={`option-choice ${isPicked ? "selected" : ""}`}
                            onClick={() => void handleToggleOption(q.id, opt.id, q.multiSelect)}
                          >
                            <span
                              style={{
                                width: 16,
                                height: 16,
                                borderRadius: q.multiSelect ? 4 : 999,
                                border: "1.5px solid var(--border-strong)",
                                background: isPicked ? "var(--accent-blue)" : "transparent",
                                color: "#fff",
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                flexShrink: 0,
                                marginTop: 2,
                              }}
                            >
                              {isPicked && <Check size={11} />}
                            </span>
                            <div style={{ flex: 1 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span style={{ fontWeight: 600, fontSize: 12.5 }}>{opt.label}</span>
                                {opt.recommended && (
                                  <span className="badge badge-green" style={{ fontSize: 10 }}>
                                    Recommended
                                  </span>
                                )}
                              </div>
                              {opt.description && (
                                <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>
                                  {opt.description}
                                </div>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="drawer-section" data-testid="threads-section">
            <div className="drawer-section-title">
              <span>
                <MessageSquare size={12} style={{ verticalAlign: "middle", marginRight: 5 }} />
                Anchored Comments ({openThreadsCount} open / {threads.length})
              </span>
            </div>

            {threads.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--text-muted)", padding: "8px 0" }}>
                No pins yet — pick a DOM element, drag a box region, select an Excalidraw node, or highlight spec text.
              </div>
            )}

            {threads.map((thread) => {
              const isSelected = activeThreadId === thread.id

              return (
                <div
                  key={thread.id}
                  data-testid={`drawer-thread-${thread.pinNumber}`}
                  className={`thread-item ${isSelected ? "active" : ""}`}
                  style={{ opacity: thread.resolved ? 0.62 : 1 }}
                  onClick={() => handleSelectThread(thread)}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                    <span className="badge badge-red">#{thread.pinNumber}</span>
                    <div className="btn-row">
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{thread.author}</span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ padding: "2px 6px", fontSize: 11 }}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          void hubApi.setCommentResolved(thread.id, !thread.resolved).then(() => loadDetail())
                        }}
                      >
                        {thread.resolved ? <RotateCcw size={11} /> : <Check size={11} />}
                        {thread.resolved ? "Reopen" : "Resolve"}
                      </button>
                    </div>
                  </div>

                  <div className="thread-anchor-chip">{describeAnchorChip(thread.anchor)}</div>

                  <div style={{ fontSize: 13 }}>{thread.body}</div>

                  {thread.replies.length > 0 && (
                    <div
                      style={{
                        borderTop: "1px solid var(--border-subtle)",
                        paddingTop: 6,
                        marginTop: 4,
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      {thread.replies.map((r) => (
                        <div key={r.id} style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                          <strong>{r.author}:</strong> {r.body}
                        </div>
                      ))}
                    </div>
                  )}

                  {isSelected && (
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }} onClick={(ev) => ev.stopPropagation()}>
                      <input
                        className="input"
                        style={{ padding: "4px 8px", fontSize: 12 }}
                        placeholder="Reply to thread..."
                        value={replyDrafts[thread.id] ?? ""}
                        onChange={(ev) => setReplyDrafts((prev) => ({ ...prev, [thread.id]: ev.target.value }))}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter") void handleReplySubmit(thread.id)
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void handleReplySubmit(thread.id)}
                      >
                        <Send size={11} />
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </aside>
      </div>
    </div>
  )
}
