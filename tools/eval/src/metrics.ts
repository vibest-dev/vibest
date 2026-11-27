import { Predicate, Schema } from "effect"

import type { HttpLogEntry, ToolCallTrace, TranscriptMetrics, TurnTrace } from "./types.ts"

const isJsonObject = Schema.is(Schema.JsonObject)

export const redactSecrets = (input: string): string =>
  input
    .replaceAll(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[REDACTED]")
    .replaceAll(/Bearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer [REDACTED]")
    .replaceAll(/("apiKey"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2")

const strField = (obj: Schema.JsonObject, key: string): string | undefined => {
  const val = obj[key]

  return Predicate.isString(val) ? val : undefined
}

const numField = (obj: Schema.JsonObject, key: string): number => {
  const val = obj[key]

  return Predicate.isNumber(val) && Number.isFinite(val) ? val : 0
}

const parseJsonLine = (line: string): Schema.JsonObject | undefined => {
  try {
    const parsed: Schema.Json = JSON.parse(line)

    return isJsonObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const extractToolResultMap = (entries: ReadonlyArray<Schema.JsonObject>): ReadonlyMap<string, string> => {
  const results = new Map<string, string>()

  for (const entry of entries) {
    const msgVal = entry.message
    const msg = isJsonObject(msgVal) ? msgVal : entry

    if (strField(msg, "role") !== "toolResult") continue
    const callId = strField(msg, "toolCallId")

    if (!callId) continue
    const contentVal = msg.content

    if (Predicate.isString(contentVal)) {
      results.set(callId, redactSecrets(contentVal.slice(0, 1200)))
      continue
    }

    if (!Array.isArray(contentVal)) continue
    const chunks: Array<string> = []

    for (const item of contentVal) {
      if (isJsonObject(item) && Predicate.isString(item.text)) {
        chunks.push(item.text)
      }
    }

    if (chunks.length > 0) {
      results.set(callId, redactSecrets(chunks.join("\n").slice(0, 1200)))
    }
  }

  return results
}

export const parseVibestHttpLogs = (logContent: string): ReadonlyArray<HttpLogEntry> => {
  const items: Array<HttpLogEntry> = []

  for (const line of logContent.split("\n")) {
    if (!line.includes('message="Sent HTTP response"')) continue
    const ts = /timestamp=(\S+)/.exec(line)?.[1] ?? ""
    const span = Number(/http\.span=(\d+)/.exec(line)?.[1] ?? "0")
    const method = /http\.method=(\S+)/.exec(line)?.[1] ?? ""
    const url = /http\.url=(\S+)/.exec(line)?.[1] ?? ""
    const status = Number(/http\.status=(\d+)/.exec(line)?.[1] ?? "0")

    if (!method || !url || url === "/api/daemon/ping" || url === "/api/session") continue
    items.push({ timestamp: ts, method, url, status, spanMs: span })
  }

  return items
}

export const parsePiTranscript = (
  jsonlTexts: ReadonlyArray<string>,
  httpLogs: ReadonlyArray<HttpLogEntry>,
  spillFiles: ReadonlyArray<string>,
) => {
  const entries: Array<Schema.JsonObject> = []

  for (const doc of jsonlTexts) {
    for (const line of doc.split("\n")) {
      const trimmed = line.trim()

      if (!trimmed) continue
      const parsed = parseJsonLine(trimmed)

      if (parsed) entries.push(parsed)
    }
  }

  const resultByCallId = extractToolResultMap(entries)
  const turns: Array<TurnTrace> = []
  let toolCallsTotal = 0
  let bashCalls = 0
  let mcpListCalls = 0
  let mcpSearchCalls = 0
  let mcpReadCalls = 0
  let mcpCallInvocations = 0
  let codeModeExecCalls = 0
  let automationCliCalls = 0
  let mcpSkillRead = false
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let reasoningTokens = 0
  let totalTokens = 0

  for (const entry of entries) {
    const msgVal = entry.message
    const msg = isJsonObject(msgVal) ? msgVal : entry

    if (strField(msg, "role") !== "assistant") continue
    const usageVal = msg.usage
    const usage = isJsonObject(usageVal) ? usageVal : {}
    const turnIn = numField(usage, "input")
    const turnOut = numField(usage, "output")
    const turnCache = numField(usage, "cacheRead")
    const turnReason = numField(usage, "reasoning")
    const turnTotal = numField(usage, "totalTokens") || turnIn + turnOut + turnCache

    inputTokens += turnIn
    outputTokens += turnOut
    cacheReadTokens += turnCache
    reasoningTokens += turnReason
    totalTokens += turnTotal

    const thinkingParts: Array<string> = []
    const textParts: Array<string> = []
    const toolCalls: Array<ToolCallTrace> = []
    const contentVal = msg.content
    const blocks = Array.isArray(contentVal) ? contentVal : []

    for (const block of blocks) {
      if (!isJsonObject(block)) continue
      const kind = strField(block, "type")

      if (kind === "thinking") {
        const thought = strField(block, "thinking") ?? strField(block, "text") ?? ""

        if (thought) thinkingParts.push(redactSecrets(thought))
      } else if (kind === "text") {
        const txt = strField(block, "text") ?? ""

        if (txt) textParts.push(redactSecrets(txt))
      } else if (kind === "toolCall") {
        toolCallsTotal += 1
        const toolName = strField(block, "name") ?? "unknown"
        const callId = strField(block, "id") ?? ""
        const argsVal = block.arguments
        const args = isJsonObject(argsVal) ? argsVal : {}
        const cmd = strField(args, "command")
        const filePath = strField(args, "path") ?? strField(args, "file_path")

        if (toolName === "bash" && cmd !== undefined) {
          bashCalls += 1

          if (/\bvibest\s+mcp\s+(list|ls)\b/.test(cmd)) mcpListCalls += 1

          if (/\bvibest\s+mcp\s+search\b/.test(cmd)) mcpSearchCalls += 1

          if (/\bvibest\s+mcp\s+read\b/.test(cmd)) mcpReadCalls += 1

          if (/\bvibest\s+mcp\s+call\b/.test(cmd)) mcpCallInvocations += 1

          if (/\bvibest\s+mcp\s+exec\b/.test(cmd)) codeModeExecCalls += 1

          if (/\bvibest\s+automation\b/.test(cmd)) automationCliCalls += 1

          if (/skills\/mcp\/SKILL\.md/.test(cmd)) mcpSkillRead = true
        }

        if ((toolName === "read" || toolName === "Read") && filePath && /skills\/mcp\/SKILL\.md/.test(filePath)) {
          mcpSkillRead = true
        }

        const summary =
          cmd !== undefined
            ? redactSecrets(cmd)
            : filePath !== undefined
              ? `${toolName}(${filePath})`
              : `${toolName}(${redactSecrets(JSON.stringify(args)).slice(0, 240)})`

        const preview = callId ? resultByCallId.get(callId) : undefined

        toolCalls.push({
          name: toolName,
          summary,
          ...(cmd !== undefined && { command: redactSecrets(cmd) }),
          ...(preview !== undefined && { resultPreview: preview }),
        })
      }
    }

    turns.push({
      index: turns.length + 1,
      thinking: thinkingParts.join("\n\n"),
      text: textParts.join("\n\n"),
      toolCalls,
      inputTokens: turnIn,
      outputTokens: turnOut,
      cacheReadTokens: turnCache,
      reasoningTokens: turnReason,
      totalTokens: turnTotal,
    })
  }

  let httpErrorCount = 0
  let httpMcpCalls = 0
  let httpCodeModeCalls = 0
  let httpAutomationCalls = 0

  for (const log of httpLogs) {
    if (log.status >= 400) httpErrorCount += 1

    if (log.url.startsWith("/api/mcp")) httpMcpCalls += 1

    if (log.url.startsWith("/api/codemode")) httpCodeModeCalls += 1

    if (log.url.startsWith("/api/automation")) httpAutomationCalls += 1
  }

  const metrics: TranscriptMetrics = {
    assistantTurns: turns.length,
    toolCallsTotal,
    bashCalls,
    mcpListCalls,
    mcpSearchCalls,
    mcpReadCalls,
    mcpCallInvocations,
    codeModeExecCalls,
    automationCliCalls,
    mcpSkillRead,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    reasoningTokens,
    totalTokens,
    httpRequestsTotal: httpLogs.length,
    httpErrorCount,
    httpMcpCalls,
    httpCodeModeCalls,
    httpAutomationCalls,
    spillFiles,
  }

  return { turns, metrics }
}
