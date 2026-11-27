import { marked } from "marked"

const ALLOWED_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "strong",
  "b",
  "em",
  "i",
  "del",
  "s",
  "ins",
  "u",
  "sub",
  "sup",
  "kbd",
  "mark",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "a",
  "img",
  "input",
  "details",
  "summary",
  "div",
  "span",
  "dl",
  "dt",
  "dd",
  "section",
])

const VOID_TAGS = new Set(["br", "hr", "img", "input"])

const GLOBAL_ALLOWED_ATTRS = new Set(["id", "class", "title", "align", "colspan", "rowspan", "aria-label", "role"])

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function decodeHtmlEntitiesOnce(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);?/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16)

      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ""
    })
    .replace(/&#(\d+);?/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10)

      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ""
    })
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
}

function normalizeUrlForCheck(rawUrl: string): string {
  const decodedTwice = decodeHtmlEntitiesOnce(decodeHtmlEntitiesOnce(rawUrl))
  let cleaned = ""

  for (let idx = 0; idx < decodedTwice.length; idx += 1) {
    const code = decodedTwice.charCodeAt(idx)

    if (code > 0x20 && code !== 0x7f) {
      cleaned += decodedTwice[idx] ?? ""
    }
  }

  return cleaned.toLowerCase()
}

function hasExplicitScheme(normalizedUrl: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/.test(normalizedUrl)
}

export function isSafeHrefUrl(rawUrl: string): boolean {
  const normalized = normalizeUrlForCheck(rawUrl)

  if (normalized.length === 0) return false

  if (!hasExplicitScheme(normalized)) {
    return !normalized.startsWith("//")
  }

  return normalized.startsWith("http://") || normalized.startsWith("https://") || normalized.startsWith("mailto:")
}

export function isSafeImageSrcUrl(rawUrl: string): boolean {
  const normalized = normalizeUrlForCheck(rawUrl)

  if (normalized.length === 0) return false

  if (!hasExplicitScheme(normalized)) {
    return !normalized.startsWith("//")
  }

  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return true
  }

  return /^data:image\/(png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=]+$/.test(normalized)
}

function stripExecutableBlocks(html: string): string {
  let current = html.replace(/<!--[\s\S]*?-->/g, "")
  let previous = ""

  while (previous !== current) {
    previous = current
    current = current
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, "")
      .replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
      .replace(/<applet\b[^>]*>[\s\S]*?<\/applet\s*>/gi, "")
  }

  return current
}

function findTagClosingBracket(source: string, startLt: number): number {
  let activeQuote: '"' | "'" | null = null

  for (let idx = startLt + 1; idx < source.length; idx += 1) {
    const ch = source[idx]

    if (activeQuote !== null) {
      if (ch === activeQuote) activeQuote = null
      continue
    }

    if (ch === '"' || ch === "'") {
      activeQuote = ch
    } else if (ch === "<") {
      return -1
    } else if (ch === ">") {
      return idx
    }
  }

  return -1
}

function sanitizeOpeningTag(lowerTag: string, rawAttrs: string): string {
  const attrRegex = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  const parsedAttrs = new Map<string, string>()
  let match = attrRegex.exec(rawAttrs)

  while (match !== null) {
    const attrName = (match[1] ?? "").toLowerCase()
    const attrVal = match[2] ?? match[3] ?? match[4] ?? ""

    if (!attrName.startsWith("on")) {
      parsedAttrs.set(attrName, attrVal)
    }

    match = attrRegex.exec(rawAttrs)
  }

  if (lowerTag === "input") {
    const inputType = (parsedAttrs.get("type") ?? "").toLowerCase()

    if (inputType !== "checkbox") return ""
    const checked = parsedAttrs.has("checked") ? " checked" : ""

    return `<input type="checkbox" disabled${checked} />`
  }

  const safeAttrFragments: string[] = []
  let needsNoopener = false

  for (const [attrName, attrVal] of parsedAttrs.entries()) {
    if (GLOBAL_ALLOWED_ATTRS.has(attrName)) {
      safeAttrFragments.push(`${attrName}="${escapeHtmlAttr(attrVal)}"`)
      continue
    }

    if (lowerTag === "a" && attrName === "href") {
      if (isSafeHrefUrl(attrVal)) {
        safeAttrFragments.push(`href="${escapeHtmlAttr(attrVal)}"`)
      }

      continue
    }

    if (lowerTag === "a" && attrName === "target") {
      if (attrVal === "_blank") {
        safeAttrFragments.push('target="_blank"')
        needsNoopener = true
      }

      continue
    }

    if (lowerTag === "img" && attrName === "src") {
      if (isSafeImageSrcUrl(attrVal)) {
        safeAttrFragments.push(`src="${escapeHtmlAttr(attrVal)}"`)
      }

      continue
    }

    if (lowerTag === "img" && (attrName === "alt" || attrName === "width" || attrName === "height")) {
      safeAttrFragments.push(`${attrName}="${escapeHtmlAttr(attrVal)}"`)
    }
  }

  if (lowerTag === "a" && needsNoopener) {
    safeAttrFragments.push('rel="noopener noreferrer"')
  }

  const joinedAttrs = safeAttrFragments.length > 0 ? ` ${safeAttrFragments.join(" ")}` : ""

  return VOID_TAGS.has(lowerTag) ? `<${lowerTag}${joinedAttrs} />` : `<${lowerTag}${joinedAttrs}>`
}

export function sanitizeRenderedHtml(rawHtml: string): string {
  const source = stripExecutableBlocks(rawHtml)
  let output = ""
  let cursor = 0

  while (cursor < source.length) {
    const ltIdx = source.indexOf("<", cursor)

    if (ltIdx === -1) {
      output += source.slice(cursor)
      break
    }

    if (ltIdx > cursor) {
      output += source.slice(cursor, ltIdx)
    }

    const gtIdx = findTagClosingBracket(source, ltIdx)

    if (gtIdx === -1) {
      output += "&lt;"
      cursor = ltIdx + 1
      continue
    }

    const innerTag = source.slice(ltIdx + 1, gtIdx).trim()
    cursor = gtIdx + 1

    if (innerTag.startsWith("/")) {
      const closeMatch = /^\/\s*([a-zA-Z0-9-]+)/.exec(innerTag)
      const lowerClose = (closeMatch?.[1] ?? "").toLowerCase()

      if (ALLOWED_TAGS.has(lowerClose) && !VOID_TAGS.has(lowerClose)) {
        output += `</${lowerClose}>`
      }

      continue
    }

    const openMatch = /^([a-zA-Z0-9-]+)([\s\S]*)$/.exec(innerTag)

    if (!openMatch) {
      continue
    }

    const lowerTag = (openMatch[1] ?? "").toLowerCase()

    if (!ALLOWED_TAGS.has(lowerTag)) {
      continue
    }

    const rawAttrs = (openMatch[2] ?? "").replace(/\/\s*$/, "")
    output += sanitizeOpeningTag(lowerTag, rawAttrs)
  }

  return output
}

export function renderSafeMarkdownHtml(markdownSource: string): string {
  const rawHtml = String(marked.parse(markdownSource, { async: false, gfm: true }))

  return sanitizeRenderedHtml(rawHtml)
}
