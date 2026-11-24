import { WTerm } from "@wterm/dom"
import { Maximize2, RefreshCw, Terminal } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import type { ThemeMode } from "../types.ts"

function stripAnsiEscapeCodes(input: string): string {
  const esc = String.fromCharCode(27)
  let out = ""
  let idx = 0

  while (idx < input.length) {
    if (input[idx] === esc && input[idx + 1] === "[") {
      idx += 2

      while (idx < input.length && !/[a-zA-Z]/.test(input[idx] ?? "")) {
        idx += 1
      }

      idx += 1
      continue
    }

    out += input[idx] ?? ""
    idx += 1
  }

  return out
}

export function WtermView(props: {
  readonly content: string
  readonly theme: ThemeMode
  readonly compact?: boolean
  readonly title?: string
  readonly onRefresh?: () => void
  readonly onExpand?: () => void
}) {
  const { content, theme, compact = false, title, onRefresh, onExpand } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<WTerm | null>(null)
  const [ready, setReady] = useState(false)
  const [fallbackText, setFallbackText] = useState<string | null>(null)

  useEffect(() => {
    const container = hostRef.current

    if (!container) return
    let cancelled = false
    container.innerHTML = ""

    const term = new WTerm(container, {
      cols: compact ? 64 : 104,
      rows: compact ? 11 : 28,
      autoResize: true,
      renderer: "dom",
      scrollbackLines: 400,
      cursorBlink: false,
    })

    termRef.current = term

    void term
      .init()
      .then(() => {
        if (cancelled) return
        setReady(true)
        setFallbackText(null)
      })
      .catch(() => {
        if (cancelled) return
        setReady(false)
        setFallbackText(stripAnsiEscapeCodes(content))
      })

    return () => {
      cancelled = true
      termRef.current = null
      setReady(false)
      term.destroy()
    }
  }, [compact])

  useEffect(() => {
    const term = termRef.current

    if (!term || !ready) return
    term.write("\x1b[2J\x1b[H")
    const normalized = content.replace(/\r?\n/g, "\r\n")
    term.write(normalized)
  }, [content, ready])

  const themeClass = theme === "light" ? "theme-light" : ""

  return (
    <div
      className={`wterm-shell ${compact ? "is-compact" : "is-stage"}`}
      data-testid={compact ? "inline-wterm-peek" : "stage-wterm-view"}
    >
      <div className="wterm-toolbar">
        <span className="wterm-title">
          <Terminal size={12} aria-hidden="true" />
          <span>{title ?? "@wterm/dom Live Terminal"}</span>
        </span>
        <div className="wterm-actions">
          {onRefresh && (
            <button type="button" className="icon-btn" title="Refresh terminal output" onClick={onRefresh}>
              <RefreshCw size={12} aria-hidden="true" />
            </button>
          )}
          {onExpand && (
            <button type="button" className="icon-btn" title="Open in Center Stage" onClick={onExpand}>
              <Maximize2 size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {fallbackText !== null ? (
        <pre className="wterm-fallback">{fallbackText}</pre>
      ) : (
        <div ref={hostRef} className={`wterm-host ${themeClass}`} />
      )}
    </div>
  )
}
