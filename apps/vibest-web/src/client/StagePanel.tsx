import { Excalidraw, convertToExcalidrawElements, restoreElements } from "@excalidraw/excalidraw"
import { Option, Schema } from "effect"
import {
  Circle,
  Crosshair,
  FileCode2,
  Hand,
  MessageSquarePlus,
  PlusCircle,
  Save,
  SquareDashedMousePointer,
  Terminal,
  X,
} from "lucide-react"
import mermaid from "mermaid"
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from "react"

import { renderSafeMarkdownHtml } from "../markdown-safe.ts"
import type { ProjectFileEntry, SessionItem, StageItem, ThemeMode } from "../types.ts"
import { webApi } from "./api.ts"
import { WtermView } from "./WtermView.tsx"

type ExcalidrawPropsType = Parameters<typeof Excalidraw>[0]

type ExcalidrawApiInstance = Parameters<NonNullable<ExcalidrawPropsType["excalidrawAPI"]>>[0]

type HtmlMode = "interact" | "pick" | "circle" | "box"

function htmlModeHint(mode: HtmlMode): string {
  switch (mode) {
    case "pick":
      return "Hover and click any DOM element to capture its CSS selector."
    case "circle":
      return "Drag a circle over a visual region to annotate."
    case "box":
      return "Drag a box over a visual region to annotate."
    case "interact":
      return "Interactive sandboxed HTML preview."
  }
}

const HoverTargetSchema = Schema.Struct({
  selector: Schema.String,
  tagName: Schema.String,
  textPreview: Schema.String,
  left: Schema.Number,
  top: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  xRatio: Schema.Number,
  yRatio: Schema.Number,
  wRatio: Schema.Number,
  hRatio: Schema.Number,
})

type HoverTarget = typeof HoverTargetSchema.Type

const BridgeMsgSchema = Schema.Union([
  Schema.Struct({ source: Schema.Literal("vibest-web-bridge"), type: Schema.Literal("bridge-ready") }),
  Schema.Struct({
    source: Schema.Literal("vibest-web-bridge"),
    type: Schema.Literal("hover-element"),
    target: Schema.NullOr(HoverTargetSchema),
  }),
  Schema.Struct({
    source: Schema.Literal("vibest-web-bridge"),
    type: Schema.Literal("picked-element"),
    target: Schema.NullOr(HoverTargetSchema),
  }),
])

const decodeBridgeMsg = Schema.decodeUnknownOption(BridgeMsgSchema)

interface MarkdownSegment {
  readonly kind: "markdown" | "mermaid"
  readonly raw: string
}

function splitMermaidBlocks(source: string): ReadonlyArray<MarkdownSegment> {
  const segments: MarkdownSegment[] = []
  const fenceRegex = /```mermaid\s*\n([\s\S]*?)```/g
  let lastIndex = 0
  let match = fenceRegex.exec(source)

  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "markdown", raw: source.slice(lastIndex, match.index) })
    }

    segments.push({ kind: "mermaid", raw: (match[1] ?? "").trim() })
    lastIndex = match.index + match[0].length
    match = fenceRegex.exec(source)
  }

  if (lastIndex < source.length) {
    segments.push({ kind: "markdown", raw: source.slice(lastIndex) })
  }

  return segments
}

const SanitizedSegment = memo(function SanitizedSegment(props: { readonly html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: props.html }} />
})

function MermaidDiagram(props: { readonly chart: string; readonly index: number; readonly theme: ThemeMode }) {
  const { chart, index, theme } = props
  const [svgHtml, setSvgHtml] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === "dark" ? "dark" : "default",
      securityLevel: "strict",
      fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
    })
    const diagramId = `vb-mermaid-${index}-${Date.now().toString(36)}`
    mermaid
      .render(diagramId, chart)
      .then((res) => {
        if (!cancelled) {
          setSvgHtml(res.svg)
          setError(null)
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })

    return () => {
      cancelled = true
    }
  }, [chart, index, theme])

  if (error) {
    return <pre className="stage-code-fallback">{chart}</pre>
  }

  return (
    <div
      className="mermaid-card"
      data-testid={`stage-mermaid-${index}`}
      dangerouslySetInnerHTML={{ __html: svgHtml }}
    />
  )
}

type RenderedMarkdownSegment =
  | { readonly kind: "mermaid"; readonly raw: string }
  | { readonly kind: "markdown"; readonly html: string }

function MarkdownStage(props: {
  readonly file: ProjectFileEntry
  readonly content: string
  readonly theme: ThemeMode
  readonly onAddToComposer: (text: string, attachmentPath: string) => void
}) {
  const { file, content, theme, onAddToComposer } = props
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [selectedQuote, setSelectedQuote] = useState<string | null>(null)
  const [note, setNote] = useState("")

  const segments = useMemo<ReadonlyArray<RenderedMarkdownSegment>>(
    () =>
      splitMermaidBlocks(content).map((seg): RenderedMarkdownSegment =>
        seg.kind === "mermaid"
          ? { kind: "mermaid", raw: seg.raw }
          : { kind: "markdown", html: renderSafeMarkdownHtml(seg.raw) },
      ),
    [content],
  )

  const captureSelection = () => {
    const sel = window.getSelection()
    const root = bodyRef.current

    if (!sel || sel.isCollapsed || !root) return
    const text = sel.toString().replace(/\s+/g, " ").trim()

    if (text.length < 3) return

    if (sel.anchorNode && root.contains(sel.anchorNode)) {
      setSelectedQuote(text.slice(0, 200))
    }
  }

  return (
    <div className="stage-markdown-wrap" onMouseUp={captureSelection} data-testid="stage-markdown-view">
      <div className="stage-subbar">
        <span className="stage-hint">Select text or click Comment to send structured feedback to Composer.</span>
        <button
          type="button"
          className="btn-ghost btn-xs"
          data-testid="md-comment-btn"
          onClick={() => {
            captureSelection()

            if (!selectedQuote) {
              const heading =
                content
                  .split("\n")
                  .map((l) => l.replace(/^#+\s*/, "").trim())
                  .find((l) => l.length > 6) ?? file.name

              setSelectedQuote(heading.slice(0, 120))
            }
          }}
        >
          <MessageSquarePlus size={12} aria-hidden="true" />
          Comment to Composer
        </button>
      </div>

      {selectedQuote && (
        <div className="stage-inline-popover" data-testid="md-composer-popover">
          <div className="popover-quote">“{selectedQuote}”</div>
          <div className="popover-row">
            <input
              type="text"
              className="search-input"
              data-testid="md-note-input"
              placeholder="Write feedback for this section..."
              value={note}
              onChange={(ev) => setNote(ev.target.value)}
              autoFocus
            />
            <button
              type="button"
              className="btn-primary btn-xs"
              data-testid="md-add-to-composer-btn"
              onClick={() => {
                const payload = `[Feedback on @${file.relativePath}]\n> "${selectedQuote}"\n${note.trim() || "Please refine this section."}`
                onAddToComposer(payload, file.relativePath)
                setSelectedQuote(null)
                setNote("")
              }}
            >
              Add to Composer
            </button>
            <button type="button" className="icon-btn" onClick={() => setSelectedQuote(null)}>
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      <div ref={bodyRef} className="panel-scroll stage-markdown-body markdown-prose">
        {segments.map((seg, idx) =>
          seg.kind === "mermaid" ? (
            <MermaidDiagram key={`m-${idx}`} chart={seg.raw} index={idx} theme={theme} />
          ) : (
            <SanitizedSegment key={`md-${idx}`} html={seg.html} />
          ),
        )}
      </div>
    </div>
  )
}

interface PendingHtmlFeedback {
  readonly kind: "element" | "circle" | "box"
  readonly label: string
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

function HtmlPreviewStage(props: {
  readonly file: ProjectFileEntry
  readonly onAddToComposer: (text: string, attachmentPath: string) => void
}) {
  const { file, onAddToComposer } = props
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [mode, setMode] = useState<HtmlMode>("pick")
  const modeRef = useRef<HtmlMode>(mode)
  modeRef.current = mode

  const [hoverTarget, setHoverTarget] = useState<HoverTarget | null>(null)
  const [dragStart, setDragStart] = useState<{ readonly x: number; readonly y: number } | null>(null)
  const [dragCurrent, setDragCurrent] = useState<{ readonly x: number; readonly y: number } | null>(null)
  const [pending, setPending] = useState<PendingHtmlFeedback | null>(null)
  const [note, setNote] = useState("")

  const previewUrl = `/api/projects/${encodeURIComponent(file.projectId)}/preview?path=${encodeURIComponent(file.relativePath)}`

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!iframeRef.current || ev.source !== iframeRef.current.contentWindow) return
      const decoded = decodeBridgeMsg(ev.data)

      if (Option.isNone(decoded)) return
      const msg = decoded.value

      if (msg.type === "hover-element" && modeRef.current === "pick") {
        setHoverTarget(msg.target)
      } else if (msg.type === "picked-element" && modeRef.current === "pick" && msg.target) {
        const t = msg.target
        setHoverTarget(t)
        setPending({
          kind: "element",
          label: `${t.tagName} ${t.selector}${t.textPreview ? ` ("${t.textPreview}")` : ""}`,
          left: t.left,
          top: t.top,
          width: t.width,
          height: t.height,
        })
        setNote("")
      }
    }

    window.addEventListener("message", onMessage)

    return () => {
      window.removeEventListener("message", onMessage)
    }
  }, [])

  const localPoint = (ev: MouseEvent<HTMLDivElement>) => {
    const bounds = wrapperRef.current?.getBoundingClientRect()

    if (!bounds) return { x: 0, y: 0 }

    return {
      x: Math.max(0, Math.min(bounds.width, ev.clientX - bounds.left)),
      y: Math.max(0, Math.min(bounds.height, ev.clientY - bounds.top)),
    }
  }

  const handleMouseMove = (ev: MouseEvent<HTMLDivElement>) => {
    const pt = localPoint(ev)

    if ((mode === "circle" || mode === "box") && dragStart) {
      setDragCurrent(pt)

      return
    }

    if (mode === "pick") {
      iframeRef.current?.contentWindow?.postMessage(
        { source: "vibest-web-parent", type: "inspect-point", x: pt.x, y: pt.y },
        "*",
      )
    }
  }

  const handleMouseDown = (ev: MouseEvent<HTMLDivElement>) => {
    if (mode !== "circle" && mode !== "box") return
    const pt = localPoint(ev)
    setPending(null)
    setDragStart(pt)
    setDragCurrent(pt)
  }

  const handleMouseUp = (ev: MouseEvent<HTMLDivElement>) => {
    if ((mode !== "circle" && mode !== "box") || !dragStart) return
    const end = localPoint(ev)
    const left = Math.min(dragStart.x, end.x)
    const top = Math.min(dragStart.y, end.y)
    const width = Math.max(24, Math.abs(end.x - dragStart.x))
    const height = Math.max(24, Math.abs(end.y - dragStart.y))
    setDragStart(null)
    setDragCurrent(null)
    setPending({
      kind: mode,
      label: `${mode === "circle" ? "Circle" : "Box"} region (${Math.round(left)}, ${Math.round(top)}, ${Math.round(width)}×${Math.round(height)}px)`,
      left,
      top,
      width,
      height,
    })
    setNote("")
  }

  const handleClick = (ev: MouseEvent<HTMLDivElement>) => {
    if (mode !== "pick") return
    const pt = localPoint(ev)
    iframeRef.current?.contentWindow?.postMessage(
      { source: "vibest-web-parent", type: "pick-point", x: pt.x, y: pt.y },
      "*",
    )
  }

  const handleWheel = (ev: WheelEvent<HTMLDivElement>) => {
    iframeRef.current?.contentWindow?.postMessage(
      { source: "vibest-web-parent", type: "scroll-by", dx: ev.deltaX, dy: ev.deltaY },
      "*",
    )
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
    <div className="stage-html-wrap" data-testid="stage-html-view">
      <div className="stage-subbar">
        <div className="segmented" role="group" aria-label="HTML preview annotation mode">
          <button
            type="button"
            data-testid="html-mode-interact"
            className={`segmented-btn ${mode === "interact" ? "is-active" : ""}`}
            onClick={() => {
              setMode("interact")
              setHoverTarget(null)
            }}
          >
            <Hand size={12} aria-hidden="true" />
            Interact
          </button>
          <button
            type="button"
            data-testid="html-mode-pick"
            className={`segmented-btn ${mode === "pick" ? "is-active" : ""}`}
            onClick={() => setMode("pick")}
          >
            <Crosshair size={12} aria-hidden="true" />
            Pick Element
          </button>
          <button
            type="button"
            data-testid="html-mode-circle"
            className={`segmented-btn ${mode === "circle" ? "is-active" : ""}`}
            onClick={() => {
              setMode("circle")
              setHoverTarget(null)
            }}
          >
            <Circle size={12} aria-hidden="true" />
            Circle
          </button>
          <button
            type="button"
            data-testid="html-mode-box"
            className={`segmented-btn ${mode === "box" ? "is-active" : ""}`}
            onClick={() => {
              setMode("box")
              setHoverTarget(null)
            }}
          >
            <SquareDashedMousePointer size={12} aria-hidden="true" />
            Box
          </button>
        </div>

        <span className="stage-hint">{htmlModeHint(mode)}</span>
      </div>

      <div ref={wrapperRef} className="html-iframe-stage">
        <iframe
          ref={iframeRef}
          src={previewUrl}
          title={file.name}
          sandbox="allow-scripts allow-same-origin"
          className="html-preview-iframe"
        />

        {mode !== "interact" && (
          <div
            className={`html-overlay is-${mode}`}
            data-testid="html-annotation-overlay"
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onClick={handleClick}
            onWheel={handleWheel}
          >
            {mode === "pick" && hoverTarget && (
              <div
                className="html-hover-box"
                style={{
                  left: hoverTarget.left,
                  top: hoverTarget.top,
                  width: hoverTarget.width,
                  height: hoverTarget.height,
                }}
              >
                <span className="html-selector-tag">{hoverTarget.selector}</span>
              </div>
            )}

            {activeDragBox && (
              <div
                className={`html-region-shape ${mode === "circle" ? "is-circle" : ""}`}
                style={{
                  left: activeDragBox.left,
                  top: activeDragBox.top,
                  width: activeDragBox.width,
                  height: activeDragBox.height,
                }}
              />
            )}

            {pending && (
              <div
                className={`html-region-shape is-pinned ${pending.kind === "circle" ? "is-circle" : ""}`}
                style={{
                  left: pending.left,
                  top: pending.top,
                  width: pending.width,
                  height: pending.height,
                }}
              />
            )}
          </div>
        )}

        {pending && (
          <div className="html-feedback-popover" data-testid="html-feedback-popover">
            <div className="popover-target-label">{pending.label}</div>
            <div className="popover-row">
              <input
                type="text"
                className="search-input"
                data-testid="html-feedback-input"
                placeholder="Describe visual adjustment..."
                value={note}
                onChange={(ev) => setNote(ev.target.value)}
                autoFocus
              />
              <button
                type="button"
                className="btn-primary btn-xs"
                data-testid="html-add-to-composer-btn"
                onClick={() => {
                  const formatted = `[Visual Feedback @${file.relativePath}]\nTarget: ${pending.label}\nNote: ${note.trim() || "Tighten spacing and contrast here."}`
                  onAddToComposer(formatted, file.relativePath)
                  setPending(null)
                  setNote("")
                }}
              >
                Add to Composer
              </button>
              <button type="button" className="icon-btn" onClick={() => setPending(null)}>
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function restoreExcalidrawScene(raw: string, theme: ThemeMode) {
  try {
    const parsed = JSON.parse(raw)
    const elements = restoreElements(parsed?.elements ?? [], null)

    return {
      elements,
      appState: {
        viewBackgroundColor: theme === "dark" ? "#13161b" : "#ffffff",
        theme,
      },
      scrollToContent: true,
    }
  } catch {
    return {
      elements: restoreElements([], null),
      appState: {
        viewBackgroundColor: theme === "dark" ? "#13161b" : "#ffffff",
        theme,
      },
      scrollToContent: true,
    }
  }
}

function ExcalidrawStage(props: {
  readonly file: ProjectFileEntry
  readonly initialContent: string
  readonly theme: ThemeMode
  readonly onAddToComposer: (text: string, attachmentPath: string) => void
}) {
  const { file, initialContent, theme, onAddToComposer } = props
  const apiRef = useRef<ExcalidrawApiInstance | null>(null)
  const [saveLabel, setSaveLabel] = useState("Saved")

  const initialData = useMemo(() => restoreExcalidrawScene(initialContent, theme), [file.id, initialContent, theme])

  const handleApi = useCallback((api: ExcalidrawApiInstance) => {
    apiRef.current = api
    setTimeout(() => {
      const els = api.getSceneElements()

      if (els.length > 0) {
        api.scrollToContent(els, { fitToViewport: true, animate: false })
      }
    }, 80)
  }, [])

  const handleSave = async () => {
    const api = apiRef.current

    if (!api) return
    setSaveLabel("Saving...")

    const payload = JSON.stringify(
      {
        type: "excalidraw",
        version: 2,
        source: "vibest-web",
        elements: api.getSceneElements(),
        appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor },
      },
      null,
      2,
    )

    await webApi.saveFileContent(file.projectId, file.relativePath, payload)
    setSaveLabel("Saved")
  }

  const handleAddNode = () => {
    const api = apiRef.current

    if (!api) return
    const current = api.getSceneElements()

    const created = convertToExcalidrawElements([
      {
        type: "rectangle",
        x: 340,
        y: 260 + (current.length % 4) * 72,
        width: 220,
        height: 64,
        backgroundColor: "#2563eb",
        strokeColor: "#93c5fd",
        fillStyle: "solid",
        label: {
          text: `Panel Gate ${current.length + 1}`,
          fontSize: 15,
          fontFamily: 2,
          strokeColor: "#ffffff",
        },
      },
    ])

    api.updateScene({ elements: [...current, ...created] })
    setSaveLabel("Unsaved")
  }

  return (
    <div className="stage-excalidraw-wrap" data-testid="stage-excalidraw-view">
      <div className="stage-subbar">
        <div className="btn-row">
          <button
            type="button"
            className="btn-ghost btn-xs"
            data-testid="excalidraw-add-node-btn"
            onClick={handleAddNode}
          >
            <PlusCircle size={12} aria-hidden="true" />
            Add Node
          </button>
          <button
            type="button"
            className="btn-primary btn-xs"
            data-testid="excalidraw-save-btn"
            onClick={() => void handleSave()}
          >
            <Save size={12} aria-hidden="true" />
            Save to Artifacts
          </button>
          <button
            type="button"
            className="btn-ghost btn-xs"
            onClick={() =>
              onAddToComposer(
                `[Architecture Board @${file.relativePath}]\nUpdated board diagram — align implementation with these panel boundaries.`,
                file.relativePath,
              )
            }
          >
            <MessageSquarePlus size={12} aria-hidden="true" />
            Add to Composer
          </button>
        </div>
        <span className="meta-chip" data-testid="excalidraw-save-state">
          {saveLabel}
        </span>
      </div>

      <div className="excalidraw-canvas-host">
        <Excalidraw
          key={file.id}
          excalidrawAPI={handleApi}
          initialData={initialData}
          theme={theme}
          onChange={() => setSaveLabel("Unsaved")}
        />
      </div>
    </div>
  )
}

export function StagePanel(props: {
  readonly item: StageItem
  readonly theme: ThemeMode
  readonly sessions: ReadonlyArray<SessionItem>
  readonly peekText: string
  readonly onRefreshPeek: (sessionId: string) => void
  readonly onAddToComposer: (text: string, attachmentPath?: string) => void
  readonly onClose: () => void
}) {
  const { item, theme, sessions, peekText, onRefreshPeek, onAddToComposer, onClose } = props
  const [content, setContent] = useState<string>("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (item.kind !== "file") return

    if (item.file.kind === "image" || item.file.kind === "video") {
      setContent("")

      return
    }

    let cancelled = false
    setLoading(true)
    void webApi
      .getFileContent(item.file.projectId, item.file.relativePath)
      .then((res) => {
        if (!cancelled) setContent(res.content)
      })
      .catch(() => {
        if (!cancelled) setContent("Unable to load file.")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [item])

  if (item.kind === "terminal") {
    const session = sessions.find((s) => s.id === item.sessionId)

    return (
      <section className="panel panel-stage" data-testid="stage-panel">
        <header className="panel-header">
          <div className="panel-title-group">
            <Terminal size={14} className="panel-icon" aria-hidden="true" />
            <span className="panel-title">Terminal · {session?.name ?? item.sessionId.slice(0, 8)}</span>
            {session?.git?.branch ? <span className="meta-chip meta-branch">{session.git.branch}</span> : null}
          </div>
          <button type="button" className="icon-btn" title="Close Stage" onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div className="stage-body">
          <WtermView
            content={peekText}
            theme={theme}
            title={`${session?.harness ?? "harness"} · ${session?.name ?? item.sessionId.slice(0, 8)}`}
            onRefresh={() => onRefreshPeek(item.sessionId)}
          />
        </div>
      </section>
    )
  }

  const file = item.file
  const rawUrl = `/api/projects/${encodeURIComponent(file.projectId)}/file?path=${encodeURIComponent(file.relativePath)}&raw=1`

  return (
    <section className="panel panel-stage" data-testid="stage-panel">
      <header className="panel-header">
        <div className="panel-title-group">
          <FileCode2 size={14} className="panel-icon" aria-hidden="true" />
          <span className="panel-title" title={file.relativePath}>
            {file.name}
          </span>
          <span className="file-ext-pill">{file.category}</span>
        </div>
        <button type="button" className="icon-btn" data-testid="stage-close-btn" title="Close Stage" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      <div className="stage-body">
        {loading ? (
          <div className="empty-state">Loading {file.name}...</div>
        ) : file.kind === "markdown" ? (
          <MarkdownStage file={file} content={content} theme={theme} onAddToComposer={onAddToComposer} />
        ) : file.kind === "html" ? (
          <HtmlPreviewStage file={file} onAddToComposer={onAddToComposer} />
        ) : file.kind === "excalidraw" ? (
          <ExcalidrawStage file={file} initialContent={content} theme={theme} onAddToComposer={onAddToComposer} />
        ) : file.kind === "image" ? (
          <div className="stage-media-wrap">
            <img src={rawUrl} alt={file.name} className="stage-image" />
          </div>
        ) : file.kind === "video" ? (
          <div className="stage-media-wrap">
            <video src={rawUrl} controls className="stage-video" />
          </div>
        ) : (
          <pre className="panel-scroll stage-text-body">{content}</pre>
        )}
      </div>
    </section>
  )
}
