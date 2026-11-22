import { Crosshair, Hand, MousePointerClick, SquareDashedMousePointer } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from "react"
import { z } from "zod"

import type { Artifact, CommentAnchor, CommentThread } from "../schema.ts"

export type HtmlAnnotationMode = "interact" | "pick" | "region"

const HoverTargetSchema = z.object({
  selector: z.string(),
  tagName: z.string(),
  textPreview: z.string(),
  left: z.number(),
  top: z.number(),
  width: z.number(),
  height: z.number(),
  xRatio: z.number(),
  yRatio: z.number(),
  wRatio: z.number(),
  hRatio: z.number(),
})

type HoverTargetInfo = z.infer<typeof HoverTargetSchema>

const RectBoxSchema = z.object({
  left: z.number(),
  top: z.number(),
  width: z.number(),
  height: z.number(),
})

type ResolvedOverlayBox = z.infer<typeof RectBoxSchema>

const BridgeIncomingMessageSchema = z.discriminatedUnion("type", [
  z.object({
    source: z.literal("vibest-hub-bridge"),
    type: z.literal("bridge-ready"),
  }),
  z.object({
    source: z.literal("vibest-hub-bridge"),
    type: z.literal("hover-element"),
    target: HoverTargetSchema.nullable(),
  }),
  z.object({
    source: z.literal("vibest-hub-bridge"),
    type: z.literal("picked-element"),
    target: HoverTargetSchema.nullable(),
  }),
  z.object({
    source: z.literal("vibest-hub-bridge"),
    type: z.literal("selector-rects"),
    rects: z.record(z.string(), RectBoxSchema.nullable()),
  }),
])

interface PendingDraftAnchor {
  anchor: CommentAnchor
  popoverLeft: number
  popoverTop: number
  summaryLabel: string
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

function normalizeTargetRatios(target: HoverTargetInfo, wrapper: HTMLDivElement | null): HoverTargetInfo {
  if (!wrapper) return target
  const stageWidth = wrapper.clientWidth || 1
  const stageHeight = wrapper.clientHeight || 1

  return {
    ...target,
    xRatio: target.left / stageWidth,
    yRatio: target.top / stageHeight,
    wRatio: target.width / stageWidth,
    hRatio: target.height / stageHeight,
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
  const modeRef = useRef<HtmlAnnotationMode>(mode)
  modeRef.current = mode
  const variantIdRef = useRef<string>(variantId)
  variantIdRef.current = variantId

  const [regionStyle, setRegionStyle] = useState<"box" | "circle">("box")
  const [hoverInfo, setHoverInfo] = useState<HoverTargetInfo | null>(null)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null)
  const [draft, setDraft] = useState<PendingDraftAnchor | null>(null)
  const [commentText, setCommentText] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [bridgeRectsByThread, setBridgeRectsByThread] = useState<Record<string, ResolvedOverlayBox | null>>({})
  const [layoutTick, setLayoutTick] = useState(0)

  const visibleThreads = useMemo(
    () =>
      threads.flatMap((t) => {
        if (t.anchor.kind === "dom" && t.anchor.variantId === variantId) return [t]

        if (t.anchor.kind === "region" && t.anchor.variantId === variantId) return [t]

        return []
      }),
    [threads, variantId],
  )

  const openDraftForPickedTarget = useCallback((picked: HoverTargetInfo) => {
    const wrapper = wrapperRef.current
    const normalized = normalizeTargetRatios(picked, wrapper)
    const stageWidth = wrapper?.clientWidth || 800
    const stageHeight = wrapper?.clientHeight || 620

    const popLeft = Math.min(Math.max(16, normalized.left + normalized.width / 2 - 155), Math.max(16, stageWidth - 326))

    const popTop = Math.min(Math.max(16, normalized.top + normalized.height + 12), Math.max(16, stageHeight - 210))

    setDraft({
      anchor: {
        kind: "dom",
        variantId: variantIdRef.current,
        selector: normalized.selector,
        tagName: normalized.tagName,
        textPreview: normalized.textPreview,
        xRatio: normalized.xRatio,
        yRatio: normalized.yRatio,
        wRatio: normalized.wRatio,
        hRatio: normalized.hRatio,
      },
      popoverLeft: popLeft,
      popoverTop: popTop,
      summaryLabel: `${normalized.tagName} ${normalized.selector}${normalized.textPreview ? ` "${normalized.textPreview}"` : ""}`,
    })
    setCommentText("")
  }, [])

  const requestDomSelectorRects = useCallback(() => {
    const win = iframeRef.current?.contentWindow

    if (!win) return

    const domQueries = visibleThreads.flatMap((t) =>
      t.anchor.kind === "dom" ? [{ id: t.id, selector: t.anchor.selector }] : [],
    )

    win.postMessage(
      {
        source: "vibest-hub-parent",
        type: "query-selectors",
        threads: domQueries,
      },
      "*",
    )
  }, [visibleThreads])

  useEffect(() => {
    setBridgeRectsByThread({})
    setHoverInfo(null)
    requestDomSelectorRects()
  }, [variantId, version, requestDomSelectorRects])

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!iframeRef.current || ev.source !== iframeRef.current.contentWindow) return
      const parsed = BridgeIncomingMessageSchema.safeParse(ev.data)

      if (!parsed.success) return
      const msg = parsed.data

      switch (msg.type) {
        case "bridge-ready":
          requestDomSelectorRects()
          break
        case "hover-element":
          if (modeRef.current === "pick") {
            setHoverInfo(msg.target ? normalizeTargetRatios(msg.target, wrapperRef.current) : null)
          }

          break
        case "picked-element":
          if (modeRef.current === "pick" && msg.target) {
            setHoverInfo(normalizeTargetRatios(msg.target, wrapperRef.current))
            openDraftForPickedTarget(msg.target)
          }

          break
        case "selector-rects":
          setBridgeRectsByThread(msg.rects)
          break
      }
    }

    const onResize = () => {
      setLayoutTick((n) => n + 1)
      requestDomSelectorRects()
    }

    window.addEventListener("message", onMessage)
    window.addEventListener("resize", onResize)

    return () => {
      window.removeEventListener("message", onMessage)
      window.removeEventListener("resize", onResize)
    }
  }, [openDraftForPickedTarget, requestDomSelectorRects])

  const resolvedBoxesByThread = useMemo(() => {
    void layoutTick
    const wrapper = wrapperRef.current
    const stageWidth = wrapper?.clientWidth || 800
    const stageHeight = wrapper?.clientHeight || 620
    const nextBoxes: Record<string, ResolvedOverlayBox> = {}

    for (const thread of visibleThreads) {
      if (thread.anchor.kind === "dom") {
        const liveRect = bridgeRectsByThread[thread.id]

        if (liveRect) {
          nextBoxes[thread.id] = liveRect
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

    return nextBoxes
  }, [bridgeRectsByThread, layoutTick, visibleThreads])

  const previewSrc = `/api/artifacts/${encodeURIComponent(artifact.id)}/preview?variant=${encodeURIComponent(variantId)}&version=${version}`

  const handleOverlayMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const wrapper = wrapperRef.current
    const win = iframeRef.current?.contentWindow

    if (!wrapper) return

    const bounds = wrapper.getBoundingClientRect()
    const localX = Math.max(0, Math.min(bounds.width, e.clientX - bounds.left))
    const localY = Math.max(0, Math.min(bounds.height, e.clientY - bounds.top))

    if (mode === "region" && dragStart) {
      setDragCurrent({ x: localX, y: localY })

      return
    }

    if (mode === "pick" && win) {
      win.postMessage(
        {
          source: "vibest-hub-parent",
          type: "inspect-point",
          x: localX,
          y: localY,
        },
        "*",
      )
    }
  }

  const handleOverlayClick = (e: MouseEvent<HTMLDivElement>) => {
    if (mode !== "pick") return
    const wrapper = wrapperRef.current
    const win = iframeRef.current?.contentWindow

    if (!wrapper) return

    const bounds = wrapper.getBoundingClientRect()
    const localX = Math.max(0, Math.min(bounds.width, e.clientX - bounds.left))
    const localY = Math.max(0, Math.min(bounds.height, e.clientY - bounds.top))

    if (win) {
      win.postMessage(
        {
          source: "vibest-hub-parent",
          type: "pick-point",
          x: localX,
          y: localY,
        },
        "*",
      )
    } else if (hoverInfo) {
      openDraftForPickedTarget(hoverInfo)
    }
  }

  const handleOverlayWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (mode === "interact") return
    iframeRef.current?.contentWindow?.postMessage(
      {
        source: "vibest-hub-parent",
        type: "scroll-by",
        dx: e.deltaX,
        dy: e.deltaY,
      },
      "*",
    )
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
          sandbox="allow-scripts"
          title={`${artifact.title} (${variantId})`}
          className="html-stage-iframe"
          onLoad={() => {
            setLayoutTick((n) => n + 1)
            requestDomSelectorRects()
          }}
        />

        <div
          data-testid="html-annotation-overlay"
          className={`stage-overlay-layer ${mode !== "interact" ? "stage-overlay-interactive" : ""}`}
          onMouseMove={handleOverlayMouseMove}
          onMouseLeave={() => setHoverInfo(null)}
          onClick={handleOverlayClick}
          onWheel={handleOverlayWheel}
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
            const box = resolvedBoxesByThread[thread.id]

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
