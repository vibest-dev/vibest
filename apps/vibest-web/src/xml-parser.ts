import type { MessageBlock } from "./types.ts"

const AGENT_MESSAGE_PATTERN = /<vibest-agent-message>([\s\S]*?)<\/vibest-agent-message>/g
const VIBEST_MESSAGE_PATTERN = /<vibest-message>([\s\S]*?)<\/vibest-message>/g

const COMBINED_TAG_PATTERN =
  /<vibest-agent-message>([\s\S]*?)<\/vibest-agent-message>|<vibest-message>([\s\S]*?)<\/vibest-message>/g

interface SummarySplit {
  readonly firstLine: string
  readonly details: string
}

interface ParsedInnerAgent {
  readonly agentId: string
  readonly body: string
}

function splitSummaryAndDetails(body: string): SummarySplit {
  const trimmed = body.trim()
  const lines = trimmed.split("\n")
  const firstNonEmptyIdx = lines.findIndex((line) => line.trim().length > 0)

  if (firstNonEmptyIdx === -1) {
    return { firstLine: "Agent report received", details: "" }
  }

  const firstLine = (lines[firstNonEmptyIdx] ?? "").trim()

  const rest = lines
    .slice(firstNonEmptyIdx + 1)
    .join("\n")
    .trim()

  return { firstLine, details: rest }
}

function parseAgentInner(inner: string): ParsedInnerAgent {
  const idMatch = /<agent-id>([\s\S]*?)<\/agent-id>/.exec(inner)
  const msgMatch = /<message>([\s\S]*?)<\/message>/.exec(inner)
  const agentId = (idMatch?.[1] ?? "unknown").trim()
  const body = (msgMatch?.[1] ?? inner.replace(/<agent-id>[\s\S]*?<\/agent-id>/g, "")).trim()

  return { agentId, body }
}

export function hasStructuredVibestTags(raw: string): boolean {
  AGENT_MESSAGE_PATTERN.lastIndex = 0
  VIBEST_MESSAGE_PATTERN.lastIndex = 0

  return AGENT_MESSAGE_PATTERN.test(raw) || VIBEST_MESSAGE_PATTERN.test(raw)
}

export function parseVibestMessageBlocks(raw: string): ReadonlyArray<MessageBlock> {
  const blocks: MessageBlock[] = []
  COMBINED_TAG_PATTERN.lastIndex = 0
  let cursor = 0
  let match = COMBINED_TAG_PATTERN.exec(raw)

  while (match !== null) {
    if (match.index > cursor) {
      const textChunk = raw.slice(cursor, match.index).trim()

      if (textChunk.length > 0) {
        blocks.push({ kind: "text", text: textChunk })
      }
    }

    const agentInner = match[1]
    const systemInner = match[2]

    if (agentInner !== undefined) {
      const parsed = parseAgentInner(agentInner)
      const split = splitSummaryAndDetails(parsed.body)
      blocks.push({
        kind: "agent-report",
        agentId: parsed.agentId,
        firstLine: split.firstLine,
        details: split.details,
        rawBody: parsed.body,
      })
    } else if (systemInner !== undefined) {
      const split = splitSummaryAndDetails(systemInner)
      blocks.push({
        kind: "system-notice",
        firstLine: split.firstLine,
        body: systemInner.trim(),
      })
    }

    cursor = match.index + match[0].length
    match = COMBINED_TAG_PATTERN.exec(raw)
  }

  if (cursor < raw.length) {
    const trailing = raw.slice(cursor).trim()

    if (trailing.length > 0) {
      blocks.push({ kind: "text", text: trailing })
    }
  }

  if (blocks.length === 0 && raw.trim().length > 0) {
    blocks.push({ kind: "text", text: raw.trim() })
  }

  return blocks
}
