import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Mcp } from "@vibest/schema/mcp"

export * as McpOutputGuard from "./output-guard.ts"

export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024

const sanitizeSegment = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "server"

export const guardCallResult = (input: {
  readonly server: string
  readonly tool: string
  readonly result: Mcp.CallResult
  readonly maxBytes?: number
  readonly scratchpadDir?: string
}): Mcp.CallResult => {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const serialized = JSON.stringify(input.result)

  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return input.result
  const targetDir = input.scratchpadDir ?? process.env.VIBEST_SCRATCHPAD_DIR ?? os.tmpdir()
  fs.mkdirSync(targetDir, { recursive: true })
  const fileName = `mcp-${sanitizeSegment(input.server)}-${sanitizeSegment(input.tool)}-${crypto.randomUUID()}.txt`
  const outputFile = path.join(targetDir, fileName)

  const fullText = input.result.content
    .map((block) => (block.type === "text" ? block.text : `[${block.mimeType} ${block.data.length} bytes]`))
    .join("\n")

  fs.writeFileSync(outputFile, fullText.length > 0 ? fullText : serialized, "utf8")
  const previewBudget = Math.max(512, Math.floor(maxBytes / 2))
  const previewSource = fullText.length > 0 ? fullText : serialized
  const preview = previewSource.slice(0, previewBudget)

  return {
    isError: input.result.isError,
    content: [
      {
        type: "text",
        text: `${preview}\n\n[Output truncated at ${maxBytes} bytes; full output saved to ${outputFile}]`,
      },
    ],
    truncated: true,
    outputFile,
  }
}

export const guardResourceResult = (input: {
  readonly server: string
  readonly uri: string
  readonly result: Mcp.ReadResourceResult
  readonly maxBytes?: number
  readonly scratchpadDir?: string
}): Mcp.ReadResourceResult => {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const serialized = JSON.stringify(input.result)

  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return input.result
  const targetDir = input.scratchpadDir ?? process.env.VIBEST_SCRATCHPAD_DIR ?? os.tmpdir()
  fs.mkdirSync(targetDir, { recursive: true })
  const fileName = `mcp-${sanitizeSegment(input.server)}-resource-${crypto.randomUUID()}.txt`
  const outputFile = path.join(targetDir, fileName)

  const fullText = input.result.contents
    .map((item) =>
      item.text !== undefined
        ? item.text
        : `[${item.mimeType ?? "application/octet-stream"} ${item.blob?.length ?? 0} base64 chars]`,
    )
    .join("\n")

  fs.writeFileSync(outputFile, fullText.length > 0 ? fullText : serialized, "utf8")
  const previewBudget = Math.max(512, Math.floor(maxBytes / 2))
  const previewSource = fullText.length > 0 ? fullText : serialized
  const preview = previewSource.slice(0, previewBudget)

  return {
    uri: input.result.uri,
    contents: [
      {
        uri: input.result.uri,
        mimeType: "text/plain",
        text: `${preview}\n\n[Output truncated at ${maxBytes} bytes; full output saved to ${outputFile}]`,
      },
    ],
    truncated: true,
    outputFile,
  }
}
