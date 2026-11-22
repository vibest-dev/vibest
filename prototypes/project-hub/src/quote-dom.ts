import type { CommentThread } from "./schema.ts"

export interface TextNodeSliceMatch {
  readonly nodeIndex: number
  readonly startOffset: number
  readonly endOffset: number
}

interface CharOrigin {
  readonly nodeIndex: number
  readonly offset: number
}

export function matchNormalizedQuoteAcrossTextNodes(
  nodeTexts: ReadonlyArray<string>,
  rawQuote: string,
): TextNodeSliceMatch[] {
  const needle = rawQuote.replace(/\s+/g, " ").trim()

  if (needle.length < 3) return []

  const normalizedChars: string[] = []
  const charOrigins: CharOrigin[] = []

  for (let nodeIndex = 0; nodeIndex < nodeTexts.length; nodeIndex += 1) {
    const text = nodeTexts[nodeIndex] ?? ""

    for (let offset = 0; offset < text.length; offset += 1) {
      const ch = text[offset] ?? ""

      if (/\s/.test(ch)) {
        if (normalizedChars.length === 0 || normalizedChars[normalizedChars.length - 1] === " ") {
          continue
        }

        normalizedChars.push(" ")
        charOrigins.push({ nodeIndex, offset })
      } else {
        normalizedChars.push(ch)
        charOrigins.push({ nodeIndex, offset })
      }
    }
  }

  const normalizedFull = normalizedChars.join("")
  const matchIdx = normalizedFull.indexOf(needle)

  if (matchIdx === -1) return []

  const slices: Array<{ nodeIndex: number; startOffset: number; endOffset: number }> = []

  for (let k = matchIdx; k < matchIdx + needle.length; k += 1) {
    const origin = charOrigins[k]

    if (!origin) continue
    const last = slices[slices.length - 1]

    if (last && last.nodeIndex === origin.nodeIndex) {
      last.endOffset = origin.offset + 1
    } else {
      slices.push({
        nodeIndex: origin.nodeIndex,
        startOffset: origin.offset,
        endOffset: origin.offset + 1,
      })
    }
  }

  return slices
}

export function clearQuoteHighlightsInDom(root: HTMLElement): void {
  const badges = Array.from(root.querySelectorAll('[data-quote-badge="true"]'))

  for (const badge of badges) {
    badge.remove()
  }

  const marks = Array.from(root.querySelectorAll("mark[data-thread-id]"))

  for (const mark of marks) {
    const parent = mark.parentNode

    if (!parent) continue

    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark)
    }

    parent.removeChild(mark)
    parent.normalize()
  }
}

function collectEligibleTextNodes(root: HTMLElement): Text[] {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let current = walker.nextNode()

  while (current !== null) {
    if (current instanceof Text) {
      const parentEl = current.parentElement

      const insideSkipped =
        parentEl?.closest('[data-quote-badge="true"]') !== null || parentEl?.closest(".mermaid-diagram-card") !== null

      if (!insideSkipped && current.data.length > 0) {
        nodes.push(current)
      }
    }

    current = walker.nextNode()
  }

  return nodes
}

export function applyQuoteHighlightsToDom(
  root: HTMLElement,
  threads: ReadonlyArray<CommentThread>,
  activeThreadId: string | null,
): number {
  clearQuoteHighlightsInDom(root)
  const doc = root.ownerDocument
  let highlightedThreadCount = 0

  for (const thread of threads) {
    if (thread.anchor.kind !== "quote") continue
    const textNodes = collectEligibleTextNodes(root)

    const slices = matchNormalizedQuoteAcrossTextNodes(
      textNodes.map((n) => n.data),
      thread.anchor.quote,
    )

    if (slices.length === 0) continue

    const cls = `anchored-quote${activeThreadId === thread.id ? " active" : ""}`

    for (let idx = slices.length - 1; idx >= 0; idx -= 1) {
      const slice = slices[idx]

      if (!slice) continue
      const targetNode = textNodes[slice.nodeIndex]

      if (!targetNode || !targetNode.parentNode) continue

      if (slice.endOffset < targetNode.data.length) {
        targetNode.splitText(slice.endOffset)
      }

      const matchedNode = slice.startOffset > 0 ? targetNode.splitText(slice.startOffset) : targetNode
      const parentNode = matchedNode.parentNode

      if (!parentNode) continue

      const mark = doc.createElement("mark")
      mark.className = cls
      mark.dataset.threadId = thread.id
      parentNode.insertBefore(mark, matchedNode)
      mark.appendChild(matchedNode)

      if (idx === slices.length - 1) {
        const badge = doc.createElement("strong")
        badge.dataset.quoteBadge = "true"
        badge.textContent = ` [#${thread.pinNumber}]`
        mark.appendChild(badge)
      }
    }

    highlightedThreadCount += 1
  }

  return highlightedThreadCount
}
