import type { MessageBlock } from "./domain/WebHub.ts"

const COMBINED_TAG_PATTERN =
  /<vibest-agent-message>([\s\S]*?)<\/vibest-agent-message>|<vibest-message>([\s\S]*?)<\/vibest-message>/g

interface SummarySplit {
  readonly firstLine: string
  readonly details: string
}

interface ParsedInnerAgent {
  readonly agentId: string
  readonly machine: string | null
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
  const sessionIdMatch = /<session-id>([\s\S]*?)<\/session-id>/.exec(inner)
  const legacyIdMatch = /<agent-id>([\s\S]*?)<\/agent-id>/.exec(inner)
  const machineMatch = /<machine>([\s\S]*?)<\/machine>/.exec(inner)
  const msgMatch = /<message>([\s\S]*?)<\/message>/.exec(inner)
  const agentId = (sessionIdMatch?.[1] ?? legacyIdMatch?.[1] ?? "unknown").trim()
  const machineRaw = machineMatch?.[1]?.trim() ?? ""
  const machine = machineRaw.length > 0 ? machineRaw : null

  const fallbackBody = inner
    .replace(/<session-id>[\s\S]*?<\/session-id>/g, "")
    .replace(/<agent-id>[\s\S]*?<\/agent-id>/g, "")
    .replace(/<machine>[\s\S]*?<\/machine>/g, "")

  const body = (msgMatch?.[1] ?? fallbackBody).trim()

  return { agentId, machine, body }
}

function unwrapSystemNotice(inner: string): string {
  const msgMatch = /<message>([\s\S]*?)<\/message>/.exec(inner)

  return (msgMatch?.[1] ?? inner).trim()
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
        machine: parsed.machine,
        firstLine: split.firstLine,
        details: split.details,
        rawBody: parsed.body,
      })
    } else if (systemInner !== undefined) {
      const body = unwrapSystemNotice(systemInner)
      const split = splitSummaryAndDetails(body)
      blocks.push({
        kind: "system-notice",
        firstLine: split.firstLine,
        body,
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
