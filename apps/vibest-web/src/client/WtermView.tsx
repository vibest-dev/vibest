import { WTerm } from "@wterm/dom"
import { Maximize2, RefreshCw, Terminal } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import type { ThemeMode } from "../types.ts"
import { Button } from "./components/ui/button.tsx"
import { cn } from "./lib/utils.ts"

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
  const [failed, setFailed] = useState(false)

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
        setFailed(false)
      })
      .catch(() => {
        if (cancelled) return
        setReady(false)
        setFailed(true)
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
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-border bg-[#0c0d10] dark:bg-[#0c0d10]",
        theme === "light" && "bg-[#fafafa]",
        !compact && "h-full",
      )}
      data-testid={compact ? "inline-wterm-peek" : "stage-wterm-view"}
    >
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border bg-muted/40 px-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground">
          <Terminal className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{title ?? "@wterm/dom Live Terminal"}</span>
        </span>
        <div className="flex items-center gap-0.5">
          {onRefresh && (
            <Button type="button" variant="ghost" size="icon-xs" title="Refresh terminal output" onClick={onRefresh}>
              <RefreshCw className="size-3" aria-hidden="true" />
            </Button>
          )}
          {onExpand && (
            <Button type="button" variant="ghost" size="icon-xs" title="Open in Center Stage" onClick={onExpand}>
              <Maximize2 className="size-3" aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      {failed ? (
        <pre className="m-0 overflow-auto p-2.5 font-mono text-xs leading-relaxed text-foreground">
          {stripAnsiEscapeCodes(content)}
        </pre>
      ) : (
        <div
          ref={hostRef}
          className={cn("wterm-host w-full overflow-auto", compact ? "h-48" : "min-h-0 flex-1", themeClass)}
        />
      )}
    </div>
  )
}
