import { MessageSquareQuote } from "lucide-react"
import mermaid from "mermaid"
import { memo, useEffect, useMemo, useRef, useState } from "react"

import { renderSafeMarkdownHtml } from "../markdown-safe.ts"
import { applyQuoteHighlightsToDom } from "../quote-dom.ts"
import type { CommentAnchor, CommentThread } from "../schema.ts"

interface MarkdownSegment {
  kind: "markdown" | "mermaid"
  raw: string
}

type RenderedSegment =
  | { readonly kind: "mermaid"; readonly raw: string }
  | { readonly kind: "markdown"; readonly html: string }

function splitMermaidBlocks(markdownSource: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  const fenceRegex = /```mermaid\s*\n([\s\S]*?)```/g
  let lastIndex = 0
  let match = fenceRegex.exec(markdownSource)

  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({
        kind: "markdown",
        raw: markdownSource.slice(lastIndex, match.index),
      })
    }

    segments.push({
      kind: "mermaid",
      raw: (match[1] ?? "").trim(),
    })
    lastIndex = match.index + match[0].length
    match = fenceRegex.exec(markdownSource)
  }

  if (lastIndex < markdownSource.length) {
    segments.push({
      kind: "markdown",
      raw: markdownSource.slice(lastIndex),
    })
  }

  return segments
}

const SanitizedHtmlSegment = memo(function SanitizedHtmlSegment(props: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: props.html }} />
})

function MermaidBlock(props: { chart: string; index: number }) {
  const [svgHtml, setSvgHtml] = useState<string>("")
  const [renderErr, setRenderErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    mermaid.initialize({
      startOnLoad: false,
      theme: "default",
      securityLevel: "strict",
    })
    const diagramId = `mermaid-svg-${props.index}-${Date.now().toString(36)}`
    mermaid
      .render(diagramId, props.chart)
      .then((res) => {
        if (!cancelled) {
          setSvgHtml(res.svg)
          setRenderErr(null)
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setRenderErr(err.message)
      })

    return () => {
      cancelled = true
    }
  }, [props.chart, props.index])

  if (renderErr) {
    return <pre className="code-block">{props.chart}</pre>
  }

  return (
    <div
      className="mermaid-diagram-card"
      data-testid={`mermaid-diagram-${props.index}`}
      dangerouslySetInnerHTML={{ __html: svgHtml }}
    />
  )
}

export function MarkdownViewer(props: {
  content: string
  threads: CommentThread[]
  activeThreadId: string | null
  onSelectThread: (threadId: string) => void
  onCreateComment: (body: string, anchor: CommentAnchor) => Promise<void>
}) {
  const { content, threads, activeThreadId, onSelectThread, onCreateComment } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const [selectedQuote, setSelectedQuote] = useState<{
    quote: string
    blockHeading?: string
  } | null>(null)

  const [commentBody, setCommentBody] = useState("")
  const [saving, setSaving] = useState(false)

  const renderedSegments = useMemo<RenderedSegment[]>(
    () =>
      splitMermaidBlocks(content).map((seg): RenderedSegment => {
        if (seg.kind === "mermaid") {
          return { kind: "mermaid", raw: seg.raw }
        }

        return { kind: "markdown", html: renderSafeMarkdownHtml(seg.raw) }
      }),
    [content],
  )

  useEffect(() => {
    const bodyEl = bodyRef.current

    if (!bodyEl) return
    applyQuoteHighlightsToDom(bodyEl, threads, activeThreadId)

    if (activeThreadId) {
      const mark = bodyEl.querySelector(`[data-thread-id="${CSS.escape(activeThreadId)}"]`)

      if (mark instanceof HTMLElement) {
        mark.scrollIntoView({ behavior: "smooth", block: "center" })
      }
    }
  }, [renderedSegments, threads, activeThreadId])

  const captureCurrentSelection = () => {
    const selection = window.getSelection()
    const root = bodyRef.current

    if (!selection || selection.isCollapsed || !root) return
    const text = selection.toString().replace(/\s+/g, " ").trim()

    if (text.length < 3) return
    const anchorNode = selection.anchorNode

    if (!anchorNode || !root.contains(anchorNode)) return

    let headingText: string | undefined
    const headings = Array.from(root.querySelectorAll("h1, h2, h3"))

    for (const h of headings) {
      if (anchorNode.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING) {
        headingText = (h.textContent ?? "").trim()
      }
    }

    setSelectedQuote({
      quote: text.slice(0, 220),
      ...(headingText !== undefined && { blockHeading: headingText }),
    })
  }

  const handleSubmitQuoteComment = async () => {
    if (!selectedQuote || commentBody.trim().length === 0) return
    setSaving(true)

    try {
      await onCreateComment(commentBody.trim(), {
        kind: "quote",
        quote: selectedQuote.quote,
        ...(selectedQuote.blockHeading !== undefined && { blockHeading: selectedQuote.blockHeading }),
      })
      setSelectedQuote(null)
      setCommentBody("")
      window.getSelection()?.removeAllRanges()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="markdown-container" ref={containerRef} onMouseUp={captureCurrentSelection}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          marginBottom: 18,
          borderRadius: 8,
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12.5, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
          <MessageSquareQuote size={14} />
          Highlight any phrase in the spec below to attach an inline quote comment.
        </span>
        <button
          type="button"
          data-testid="md-manual-quote-btn"
          className="btn btn-sm"
          onClick={() => {
            captureCurrentSelection()

            if (!selectedQuote) {
              const firstLine =
                content
                  .split("\n")
                  .map((l) => l.replace(/^#+\s*/, "").trim())
                  .find((l) => l.length > 10) ?? "Document overview"

              setSelectedQuote({ quote: firstLine.slice(0, 120), blockHeading: "Overview" })
            }
          }}
        >
          + Quote Comment
        </button>
      </div>

      {selectedQuote && (
        <div
          data-testid="md-quote-composer"
          className="card"
          style={{
            marginBottom: 20,
            borderColor: "var(--accent-blue)",
            background: "var(--bg-surface)",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--accent-blue)" }}>
            Inline Quote Pin #{threads.length + 1}
            {selectedQuote.blockHeading ? ` · § ${selectedQuote.blockHeading}` : ""}
          </div>
          <blockquote
            style={{
              margin: 0,
              padding: "6px 10px",
              borderLeft: "3px solid var(--accent-amber)",
              background: "var(--bg-app)",
              fontSize: 12.5,
              color: "var(--text-secondary)",
            }}
          >
            “{selectedQuote.quote}”
          </blockquote>
          <textarea
            data-testid="md-quote-input"
            className="textarea"
            placeholder="Add review note anchored to this exact quote..."
            value={commentBody}
            onChange={(ev) => setCommentBody(ev.target.value)}
            autoFocus
          />
          <div className="btn-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn btn-sm" onClick={() => setSelectedQuote(null)}>
              Cancel
            </button>
            <button
              type="button"
              data-testid="md-quote-submit"
              className="btn btn-primary btn-sm"
              disabled={saving || commentBody.trim().length === 0}
              onClick={() => void handleSubmitQuoteComment()}
            >
              {saving ? "Saving..." : "Attach Quote Comment"}
            </button>
          </div>
        </div>
      )}

      <div
        ref={bodyRef}
        className="markdown-body"
        data-testid="markdown-rendered-body"
        onClick={(ev) => {
          const target = ev.target

          if (target instanceof HTMLElement) {
            const mark = target.closest("[data-thread-id]")

            if (mark instanceof HTMLElement && mark.dataset.threadId) {
              onSelectThread(mark.dataset.threadId)
            }
          }
        }}
      >
        {renderedSegments.map((seg, index) => {
          if (seg.kind === "mermaid") {
            return <MermaidBlock key={`m-${index}`} chart={seg.raw} index={index} />
          }

          return <SanitizedHtmlSegment key={`md-${index}`} html={seg.html} />
        })}
      </div>
    </div>
  )
}
