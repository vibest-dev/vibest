import { Crosshair, Hand, MousePointerClick, SquareDashedMousePointer } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react"

import type { Artifact, CommentAnchor, CommentThread } from "../schema.ts"

export type HtmlAnnotationMode = "interact" | "pick" | "region"

interface HoverTargetInfo {
  selector: string
  tagName: string
  textPreview: string
  left: number
  top: number
  width: number
  height: number
  xRatio: number
  yRatio: number
  wRatio: number
  hRatio: number
}

interface PendingDraftAnchor {
  anchor: CommentAnchor
  popoverLeft: number
  popoverTop: number
  summaryLabel: string
}

interface ResolvedOverlayBox {
  left: number
  top: number
  width: number
  height: number
}

function buildUniqueSelector(el: Element): string {
  if (el.id) {
    return `#${CSS.escape(el.id)}`
  }

  const parts: string[] = []
  let current: Element | null = el

  while (current && current.tagName.toLowerCase() !== "html" && parts.length < 4) {
    const tag = current.tagName.toLowerCase()

    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`)
      break
    }

    const classList = Array.from(current.classList).slice(0, 2)

    const classSuffix = classList.length > 0 ? `.${classList.map((c) => CSS.escape(c)).join(".")}` : ""

    const parentEl: Element | null = current.parentElement

    if (parentEl) {
      const sameTagSiblings = Array.from(parentEl.children).flatMap((sib) =>
        sib.tagName === current?.tagName ? [sib] : [],
      )

      if (sameTagSiblings.length > 1) {
        const idx = sameTagSiblings.indexOf(current) + 1
        parts.unshift(`${tag}${classSuffix}:nth-of-type(${idx})`)
      } else {
        parts.unshift(`${tag}${classSuffix}`)
      }
    } else {
      parts.unshift(`${tag}${classSuffix}`)
    }

    current = parentEl
  }

  return parts.join(" > ") || el.tagName.toLowerCase()
}

function modeHintText(mode: HtmlAnnotationMode, count: number, variantId: string): string {
  switch (mode) {
    case "pick":
      return "Hover any element in the HTML preview and click to drop a numbered pin."
    case "region":
      return "Click and drag across any visual area to draw a region annotation."
    case "interact":
      return `${count} pin(s) on ${variantId} — switch to Pick Element or Region Select to annotate.`
  }
}

export function HtmlAnnotator(props: {
  artifact: Artifact
  version: number
  variantId: string
  mode: HtmlAnnotationMode
  onModeChange: (mode: HtmlAnnotationMode) => void
  threads: CommentThread[]
  activeThreadId: string | null
  onSelectThread: (threadId: string) => void
  onCreateComment: (body: string, anchor: CommentAnchor) => Promise<void>
}) {
  const { artifact, version, variantId, mode, onModeChange, threads, activeThreadId, onSelectThread, onCreateComment } =
    props

  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const [regionStyle, setRegionStyle] = useState<"box" | "circle">("box")
  const [hoverInfo, setHoverInfo] = useState<HoverTargetInfo | null>(null)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null)
  const [draft, setDraft] = useState<PendingDraftAnchor | null>(null)
  const [commentText, setCommentText] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [domRectsByThread, setDomRectsByThread] = useState<Record<string, ResolvedOverlayBox>>({})
  const [iframeLoadedTick, setIframeLoadedTick] = useState(0)

  const visibleThreads = threads.flatMap((t) => {
    if (t.anchor.kind === "dom" && t.anchor.variantId === variantId) return [t]

    if (t.anchor.kind === "region" && t.anchor.variantId === variantId) return [t]

    return []
  })

  const recomputeDomThreadBoxes = useCallback(() => {
    const wrapper = wrapperRef.current
    const iframe = iframeRef.current
    const doc = iframe?.contentDocument

    if (!wrapper || !iframe || !doc) return

    const stageWidth = wrapper.clientWidth || 1
    const stageHeight = wrapper.clientHeight || 1
    const nextBoxes: Record<string, ResolvedOverlayBox> = {}

    for (const thread of visibleThreads) {
      if (thread.anchor.kind === "dom") {
        let matchedEl: Element | null = null

        try {
          matchedEl = doc.querySelector(thread.anchor.selector)
        } catch {
          matchedEl = null
        }

        if (matchedEl) {
          const r = matchedEl.getBoundingClientRect()
          nextBoxes[thread.id] = {
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
          }
        } else {
          nextBoxes[thread.id] = {
            left: thread.anchor.xRatio * stageWidth,
            top: thread.anchor.yRatio * stageHeight,
            width: thread.anchor.wRatio * stageWidth,
            height: thread.anchor.hRatio * stageHeight,
          }
        }
      } else if (thread.anchor.kind === "region") {
        nextBoxes[thread.id] = {
          left: thread.anchor.xRatio * stageWidth,
          top: thread.anchor.yRatio * stageHeight,
          width: thread.anchor.wRatio * stageWidth,
          height: thread.anchor.hRatio * stageHeight,
        }
      }
    }

    setDomRectsByThread(nextBoxes)
  }, [visibleThreads])

  useEffect(() => {
    recomputeDomThreadBoxes()
    const onResize = () => recomputeDomThreadBoxes()
    window.addEventListener("resize", onResize)

    return () => window.removeEventListener("resize", onResize)
  }, [recomputeDomThreadBoxes, iframeLoadedTick, activeThreadId])

  const previewSrc = `/api/artifacts/${encodeURIComponent(artifact.id)}/preview?variant=${encodeURIComponent(variantId)}&version=${version}`

  const handleOverlayMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const wrapper = wrapperRef.current
    const iframe = iframeRef.current

    if (!wrapper || !iframe) return

    const bounds = wrapper.getBoundingClientRect()
    const localX = Math.max(0, Math.min(bounds.width, e.clientX - bounds.left))
    const localY = Math.max(0, Math.min(bounds.height, e.clientY - bounds.top))

    if (mode === "region" && dragStart) {
      setDragCurrent({ x: localX, y: localY })

      return
    }

    if (mode === "pick") {
      const doc = iframe.contentDocument

      if (!doc) return
      const target = doc.elementFromPoint(localX, localY)

      if (!target || target === doc.documentElement || target === doc.body) {
        setHoverInfo(null)

        return
      }

      const rect = target.getBoundingClientRect()
      const selector = buildUniqueSelector(target)
      const rawText = (target.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48)
      setHoverInfo({
        selector,
        tagName: target.tagName.toLowerCase(),
        textPreview: rawText,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        xRatio: rect.left / (bounds.width || 1),
        yRatio: rect.top / (bounds.height || 1),
        wRatio: rect.width / (bounds.width || 1),
        hRatio: rect.height / (bounds.height || 1),
      })
    }
  }

  const handleOverlayClick = (e: MouseEvent<HTMLDivElement>) => {
    if (mode !== "pick") return
    const wrapper = wrapperRef.current
    const iframe = iframeRef.current

    if (!wrapper || !iframe) return

    const bounds = wrapper.getBoundingClientRect()
    const localX = Math.max(0, Math.min(bounds.width, e.clientX - bounds.left))
    const localY = Math.max(0, Math.min(bounds.height, e.clientY - bounds.top))
    const doc = iframe.contentDocument

    let picked = hoverInfo

    if (!picked && doc) {
      const target = doc.elementFromPoint(localX, localY)

      if (target && target !== doc.documentElement) {
        const rect = target.getBoundingClientRect()
        picked = {
          selector: buildUniqueSelector(target),
          tagName: target.tagName.toLowerCase(),
          textPreview: (target.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48),
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          xRatio: rect.left / (bounds.width || 1),
          yRatio: rect.top / (bounds.height || 1),
          wRatio: rect.width / (bounds.width || 1),
          hRatio: rect.height / (bounds.height || 1),
        }
      }
    }

    if (!picked) return

    const popLeft = Math.min(Math.max(16, picked.left + picked.width / 2 - 155), Math.max(16, bounds.width - 326))
    const popTop = Math.min(Math.max(16, picked.top + picked.height + 12), Math.max(16, bounds.height - 210))

    setDraft({
      anchor: {
        kind: "dom",
        variantId,
        selector: picked.selector,
        tagName: picked.tagName,
        textPreview: picked.textPreview,
        xRatio: picked.xRatio,
        yRatio: picked.yRatio,
        wRatio: picked.wRatio,
        hRatio: picked.hRatio,
      },
      popoverLeft: popLeft,
      popoverTop: popTop,
      summaryLabel: `${picked.tagName} ${picked.selector}${picked.textPreview ? ` "${picked.textPreview}"` : ""}`,
    })
    setCommentText("")
  }

  const handleOverlayMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (mode !== "region") return
    const wrapper = wrapperRef.current

    if (!wrapper) return
    const bounds = wrapper.getBoundingClientRect()
    const localX = Math.max(0, Math.min(bounds.width, e.clientX - bounds.left))
    const localY = Math.max(0, Math.min(bounds.height, e.clientY - bounds.top))
    setDraft(null)
    setDragStart({ x: localX, y: localY })
    setDragCurrent({ x: localX, y: localY })
  }

  const handleOverlayMouseUp = () => {
    if (mode !== "region" || !dragStart || !dragCurrent) return
    const wrapper = wrapperRef.current

    if (!wrapper) return
    const bounds = wrapper.getBoundingClientRect()

    const left = Math.min(dragStart.x, dragCurrent.x)
    const top = Math.min(dragStart.y, dragCurrent.y)
    const width = Math.max(24, Math.abs(dragCurrent.x - dragStart.x))
    const height = Math.max(24, Math.abs(dragCurrent.y - dragStart.y))

    setDragStart(null)
    setDragCurrent(null)

    const popLeft = Math.min(Math.max(16, left), Math.max(16, bounds.width - 326))
    const popTop = Math.min(Math.max(16, top + height + 10), Math.max(16, bounds.height - 210))

    setDraft({
      anchor: {
        kind: "region",
        variantId,
        regionStyle,
        label: `${regionStyle === "circle" ? "Circle" : "Box"} (${Math.round((left / (bounds.width || 1)) * 100)}%, ${Math.round((top / (bounds.height || 1)) * 100)}%)`,
        xRatio: left / (bounds.width || 1),
        yRatio: top / (bounds.height || 1),
        wRatio: width / (bounds.width || 1),
        hRatio: height / (bounds.height || 1),
      },
      popoverLeft: popLeft,
      popoverTop: popTop,
      summaryLabel: `${regionStyle === "circle" ? "Circle Callout" : "Region Box"} (${Math.round(width)}×${Math.round(height)}px)`,
    })
    setCommentText("")
  }

  const handleSaveDraft = async () => {
    if (!draft || commentText.trim().length === 0) return
    setSubmitting(true)

    try {
      await onCreateComment(commentText.trim(), draft.anchor)
      setDraft(null)
      setCommentText("")
    } finally {
      setSubmitting(false)
    }
  }

  const activeDragBox =
    dragStart && dragCurrent
      ? {
          left: Math.min(dragStart.x, dragCurrent.x),
          top: Math.min(dragStart.y, dragCurrent.y),
          width: Math.abs(dragCurrent.x - dragStart.x),
          height: Math.abs(dragCurrent.y - dragStart.y),
        }
      : null

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-elevated)",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div className="btn-row">
          <div className="segmented" role="group" aria-label="HTML Annotation Mode">
            <button
              type="button"
              data-testid="mode-interact"
              className={`segmented-btn ${mode === "interact" ? "active" : ""}`}
              onClick={() => {
                setHoverInfo(null)
                setDraft(null)
                onModeChange("interact")
              }}
            >
              <Hand size={14} /> Interact
            </button>
            <button
              type="button"
              data-testid="mode-pick-element"
              className={`segmented-btn ${mode === "pick" ? "active" : ""}`}
              onClick={() => {
                setDraft(null)
                onModeChange("pick")
              }}
            >
              <MousePointerClick size={14} /> 点选元素评论 (Pick Element)
            </button>
            <button
              type="button"
              data-testid="mode-box-select"
              className={`segmented-btn ${mode === "region" ? "active" : ""}`}
              onClick={() => {
                setHoverInfo(null)
                setDraft(null)
                onModeChange("region")
              }}
            >
              <SquareDashedMousePointer size={14} /> 框选/圈选评论 (Region Select)
            </button>
          </div>

          {mode === "region" && (
            <div className="segmented" role="group" aria-label="Region Callout Style">
              <button
                type="button"
                data-testid="region-style-box"
                className={`segmented-btn ${regionStyle === "box" ? "active" : ""}`}
                onClick={() => setRegionStyle("box")}
              >
                Rectangle 框选
              </button>
              <button
                type="button"
                data-testid="region-style-circle"
                className={`segmented-btn ${regionStyle === "circle" ? "active" : ""}`}
                onClick={() => setRegionStyle("circle")}
              >
                Circle 圈选
              </button>
            </div>
          )}
        </div>

        <span style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
          <Crosshair size={13} />
          {modeHintText(mode, visibleThreads.length, variantId)}
        </span>
      </div>

      <div className="html-stage-wrapper" ref={wrapperRef} data-testid="html-stage-wrapper">
        <iframe
          ref={iframeRef}
          src={previewSrc}
          title={`${artifact.title} (${variantId})`}
          className="html-stage-iframe"
          onLoad={() => setIframeLoadedTick((n) => n + 1)}
        />

        <div
          data-testid="html-annotation-overlay"
          className={`stage-overlay-layer ${mode !== "interact" ? "stage-overlay-interactive" : ""}`}
          onMouseMove={handleOverlayMouseMove}
          onMouseLeave={() => setHoverInfo(null)}
          onClick={handleOverlayClick}
          onMouseDown={handleOverlayMouseDown}
          onMouseUp={handleOverlayMouseUp}
        >
          {mode === "pick" && hoverInfo && (
            <div
              className="hover-inspector-box"
              style={{
                left: hoverInfo.left,
                top: hoverInfo.top,
                width: hoverInfo.width,
                height: hoverInfo.height,
              }}
            >
              <div className="hover-inspector-label">
                {hoverInfo.tagName}
                {hoverInfo.selector.startsWith("#") ? hoverInfo.selector : ` ${hoverInfo.selector}`}
                {hoverInfo.textPreview ? ` · "${hoverInfo.textPreview.slice(0, 26)}"` : ""}
              </div>
            </div>
          )}

          {activeDragBox && (
            <div
              className={`annotation-region ${regionStyle === "circle" ? "circle" : ""}`}
              style={{
                left: activeDragBox.left,
                top: activeDragBox.top,
                width: activeDragBox.width,
                height: activeDragBox.height,
              }}
            />
          )}

          {visibleThreads.map((thread) => {
            const box = domRectsByThread[thread.id]

            if (!box) return null
            const isSelected = activeThreadId === thread.id

            if (thread.anchor.kind === "region") {
              return (
                <div key={thread.id}>
                  <div
                    data-testid={`region-callout-${thread.pinNumber}`}
                    className={`annotation-region ${thread.anchor.regionStyle === "circle" ? "circle" : ""} ${isSelected ? "active" : ""}`}
                    style={{
                      left: box.left,
                      top: box.top,
                      width: box.width,
                      height: box.height,
                      opacity: thread.resolved ? 0.45 : 1,
                    }}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      onSelectThread(thread.id)
                    }}
                  />
                  <button
                    type="button"
                    data-testid={`stage-pin-${thread.pinNumber}`}
                    className={`annotation-pin ${isSelected ? "active" : ""} ${thread.resolved ? "resolved" : ""}`}
                    style={{
                      left: box.left + box.width,
                      top: box.top,
                    }}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      onSelectThread(thread.id)
                    }}
                    title={`#${thread.pinNumber}: ${thread.body}`}
                  >
                    {thread.pinNumber}
                  </button>
                </div>
              )
            }

            return (
              <div key={thread.id}>
                {isSelected && (
                  <div
                    style={{
                      position: "absolute",
                      left: box.left - 3,
                      top: box.top - 3,
                      width: box.width + 6,
                      height: box.height + 6,
                      border: "2px solid #2563eb",
                      borderRadius: 6,
                      background: "rgba(37, 99, 235, 0.12)",
                      pointerEvents: "none",
                    }}
                  />
                )}
                <button
                  type="button"
                  data-testid={`stage-pin-${thread.pinNumber}`}
                  className={`annotation-pin ${isSelected ? "active" : ""} ${thread.resolved ? "resolved" : ""}`}
                  style={{
                    left: Math.min(box.left + box.width - 4, box.left + Math.min(box.width, 180)),
                    top: Math.max(14, box.top + 4),
                  }}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    onSelectThread(thread.id)
                  }}
                  title={`#${thread.pinNumber}: ${thread.body}`}
                >
                  {thread.pinNumber}
                </button>
              </div>
            )
          })}

          {draft && (
            <div
              className="composer-popover"
              data-testid="annotation-composer"
              style={{
                left: draft.popoverLeft,
                top: draft.popoverTop,
              }}
              onClick={(ev) => ev.stopPropagation()}
              onMouseDown={(ev) => ev.stopPropagation()}
            >
              <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--accent-blue)" }}>
                Pin #{threads.length + 1} · {draft.summaryLabel}
              </div>
              <textarea
                data-testid="annotation-composer-input"
                className="textarea"
                placeholder="Write actionable feedback for the agent..."
                value={commentText}
                onChange={(ev) => setCommentText(ev.target.value)}
                autoFocus
              />
              <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                <button type="button" className="btn btn-sm" onClick={() => setDraft(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="annotation-composer-submit"
                  className="btn btn-primary btn-sm"
                  disabled={submitting || commentText.trim().length === 0}
                  onClick={() => void handleSaveDraft()}
                >
                  {submitting ? "Saving..." : "Pin Comment"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
