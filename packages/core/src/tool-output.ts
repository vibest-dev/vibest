import { Layout } from "@vibest/schema/layout"
import type { Mcp } from "@vibest/schema/mcp"
import { LayerNode } from "@vibest/util/layer-node"
import { Clock, Context, Effect, FileSystem, Layer, Path } from "effect"

import { PlatformNode } from "./effect/platform.ts"

export * as ToolOutput from "./tool-output.ts"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024
export const DIRECTORY = "tool-output"

const encoder = new TextEncoder()
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export const countLines = (text: string): number => {
  if (text === "") return 0
  let count = 1

  for (let index = text.indexOf("\n"); index !== -1 && index < text.length - 1; index = text.indexOf("\n", index + 1)) {
    count++
  }

  return count
}

export const afterLines = (text: string, count: number): number => {
  let index = 0

  for (let line = 0; line < count; line++) {
    const next = text.indexOf("\n", index)

    if (next === -1) return text.length
    index = next + 1
  }

  return index
}

export const utf8ByteLength = (text: string): number => encoder.encode(text).byteLength

export const byteBoundary = (text: string, budget: number): number => {
  const index = encoder.encodeInto(text, new Uint8Array(Math.max(0, budget))).read

  if (index === text.length || index === 0) return index
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)

  if (before < 0x80 && after < 0x80) return before === 13 && after === 10 ? index - 1 : index
  const start = text.lastIndexOf("\n", index - 1) + 1

  return start + (graphemes.segment(text.slice(start, index + 2)).containing(index - start)?.index ?? index - start)
}

export const truncateInline = (text: string, maxBytes: number = MAX_BYTES): string => {
  if (utf8ByteLength(text) <= maxBytes) return text
  const suffix = "…"
  const suffixBytes = utf8ByteLength(suffix)
  const end = byteBoundary(text, Math.max(0, maxBytes - suffixBytes))

  return text.slice(0, end) + suffix
}

const sanitizeSegment = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "tool"

const stripTrailingLineBreak = (text: string, end: number): string =>
  text.slice(0, text.endsWith("\r\n", end) ? end - 2 : text.endsWith("\n", end) ? end - 1 : end)

const joinParts = (parts: ReadonlyArray<string>): string =>
  parts.reduce((joined, part) => (joined === "" || joined.endsWith("\n") ? joined + part : `${joined}\n${part}`), "")

export interface TruncateCallInput {
  readonly server: string
  readonly tool: string
  readonly result: Mcp.CallResult
  readonly maxBytes?: number | undefined
  readonly maxLines?: number | undefined
  readonly scratchpadDir?: string | undefined
}

export interface TruncateResourceInput {
  readonly server: string
  readonly uri: string
  readonly result: Mcp.ReadResourceResult
  readonly maxBytes?: number | undefined
  readonly maxLines?: number | undefined
  readonly scratchpadDir?: string | undefined
}

export interface Interface {
  readonly truncateCallResult: (input: TruncateCallInput) => Effect.Effect<Mcp.CallResult>
  readonly truncateResourceResult: (input: TruncateResourceInput) => Effect.Effect<Mcp.ReadResourceResult>
}

export class Service extends Context.Service<Service, Interface>()("vibest/ToolOutput") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const layout = yield* Layout
    const defaultDir = path.join(layout.home, DIRECTORY)

    const saveFullOutput = (dir: string, name: string, text: string) =>
      Effect.gen(function* () {
        const file = path.join(dir, name)

        const failure = yield* fs.makeDirectory(dir, { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(file, text)),
          Effect.as(undefined),
          Effect.catch((error) =>
            Effect.logWarning("failed to save full tool output", { file, error: error.message }).pipe(
              Effect.as(error.message),
            ),
          ),
        )

        return { file, failure }
      })

    const formatMarker = (
      text: string,
      end: number,
      shown: string,
      totalLines: number,
      file: string,
      failure: string | undefined,
    ): string => {
      const shownLines = countLines(text.slice(0, end))

      const lastLineCut =
        shownLines > 0 &&
        shown.length < text.length &&
        !text.startsWith("\n", shown.length) &&
        !text.startsWith("\r\n", shown.length)

      const range = shownLines === 0 ? "0 lines" : `lines 1-${shownLines}`

      const savedPart =
        failure === undefined ? `full output saved to ${file}` : `full output could not be saved: ${failure}`

      return `[showing ${range} of ${totalLines}${lastLineCut ? " (last line cut)" : ""}; ${savedPart}]`
    }

    const truncateCallResult = Effect.fn("ToolOutput.truncateCallResult")(function* (
      input: TruncateCallInput,
    ): Effect.fn.Return<Mcp.CallResult> {
      if (input.result.truncated !== undefined) return input.result
      const maxBytes = input.maxBytes ?? MAX_BYTES
      const maxLines = input.maxLines ?? MAX_LINES

      const textParts = input.result.content.flatMap((item) => (item.type === "text" ? [item.text] : []))
      const text = joinParts(textParts)
      const totalLines = countLines(text)

      if (totalLines <= maxLines && utf8ByteLength(text) <= maxBytes) {
        return input.result
      }

      const end = Math.min(afterLines(text, maxLines), byteBoundary(text, maxBytes))
      const shown = stripTrailingLineBreak(text, end)
      const targetDir = input.scratchpadDir ?? defaultDir
      const now = yield* Clock.currentTimeMillis
      const rand = Math.random().toString(36).slice(2, 10)
      const name = `tool_${now.toString(16)}_${sanitizeSegment(input.server)}_${sanitizeSegment(input.tool)}_${rand}.txt`
      const { file, failure } = yield* saveFullOutput(targetDir, name, text)
      const marker = formatMarker(text, end, shown, totalLines, file, failure)

      const bounded: Array<Mcp.CallContent> = []
      let remaining = shown.length
      let separator = false
      let marked = false

      for (const item of input.result.content) {
        if (item.type !== "text") {
          bounded.push(item)
          continue
        }

        if (separator && remaining > 0) remaining--
        separator = item.text !== "" && !item.text.endsWith("\n")

        if (!marked && remaining >= item.text.length) {
          bounded.push(item)
          remaining -= item.text.length
          continue
        }

        if (remaining > 0) bounded.push({ type: "text", text: item.text.slice(0, remaining) })

        if (!marked) bounded.push({ type: "text", text: marker })
        remaining = 0
        marked = true
      }

      if (!marked) bounded.push({ type: "text", text: marker })

      return {
        isError: input.result.isError,
        content: bounded,
        truncated: true,
        ...(failure === undefined && { outputFile: file }),
      }
    })

    const truncateResourceResult = Effect.fn("ToolOutput.truncateResourceResult")(function* (
      input: TruncateResourceInput,
    ): Effect.fn.Return<Mcp.ReadResourceResult> {
      if (input.result.truncated !== undefined) return input.result
      const maxBytes = input.maxBytes ?? MAX_BYTES
      const maxLines = input.maxLines ?? MAX_LINES

      const textParts = input.result.contents.flatMap((item) => (item.text !== undefined ? [item.text] : []))
      const text = joinParts(textParts)
      const totalLines = countLines(text)

      if (totalLines <= maxLines && utf8ByteLength(text) <= maxBytes) {
        return input.result
      }

      const end = Math.min(afterLines(text, maxLines), byteBoundary(text, maxBytes))
      const shown = stripTrailingLineBreak(text, end)
      const targetDir = input.scratchpadDir ?? defaultDir
      const now = yield* Clock.currentTimeMillis
      const rand = Math.random().toString(36).slice(2, 10)
      const name = `tool_${now.toString(16)}_${sanitizeSegment(input.server)}_resource_${rand}.txt`
      const { file, failure } = yield* saveFullOutput(targetDir, name, text)
      const marker = formatMarker(text, end, shown, totalLines, file, failure)

      const bounded: Array<Mcp.ResourceContent> = []
      let remaining = shown.length
      let separator = false
      let marked = false

      for (const item of input.result.contents) {
        if (item.text === undefined) {
          bounded.push(item)
          continue
        }

        if (separator && remaining > 0) remaining--
        separator = item.text !== "" && !item.text.endsWith("\n")

        if (!marked && remaining >= item.text.length) {
          bounded.push(item)
          remaining -= item.text.length
          continue
        }

        if (remaining > 0) bounded.push({ ...item, text: item.text.slice(0, remaining) })

        if (!marked) bounded.push({ uri: input.result.uri, mimeType: "text/plain", text: marker })
        remaining = 0
        marked = true
      }

      if (!marked) bounded.push({ uri: input.result.uri, mimeType: "text/plain", text: marker })

      return {
        uri: input.result.uri,
        contents: bounded,
        truncated: true,
        ...(failure === undefined && { outputFile: file }),
      }
    })

    return Service.of({ truncateCallResult, truncateResourceResult })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [PlatformNode.fileSystem, PlatformNode.path, PlatformNode.layout],
})
