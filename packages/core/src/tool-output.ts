import { Layout } from "@vibest/schema/layout"
import type { Mcp } from "@vibest/schema/mcp"
import { LayerNode } from "@vibest/util/layer-node"
import { Clock, Context, Duration, Effect, FiberSet, FileSystem, Layer, Option, Path, Schema } from "effect"

import { PlatformNode } from "./effect/platform.ts"

export * as ToolOutput from "./tool-output.ts"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024
export const RETENTION = Duration.days(7)
export const DIRECTORY = "tool-output"
const CLEANUP_INTERVAL_MS = Duration.toMillis(Duration.hours(1))
const RETENTION_MS = Duration.toMillis(RETENTION)
const CLEANUP_CONCURRENCY = 8

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

const decodeBase64Option = Schema.decodeUnknownOption(Schema.Uint8ArrayFromBase64)

const decodeBase64 = (raw: string): Uint8Array =>
  Option.getOrElse(decodeBase64Option(raw.replace(/\s+/g, "")), () => new Uint8Array())

const sliceTextItems = <Item>(input: {
  readonly items: ReadonlyArray<Item>
  readonly shownLength: number
  readonly getText: (item: Item) => string | undefined
  readonly withText: (item: Item, text: string) => Item
  readonly makeMarker: () => Item
}): Array<Item> => {
  const bounded: Array<Item> = []
  let remaining = input.shownLength
  let separator = false
  let marked = false

  for (const item of input.items) {
    const text = input.getText(item)

    if (text === undefined) {
      bounded.push(item)
      continue
    }

    if (separator && remaining > 0) remaining--
    separator = text !== "" && !text.endsWith("\n")

    if (!marked && remaining >= text.length) {
      bounded.push(item)
      remaining -= text.length
      continue
    }

    if (remaining > 0) bounded.push(input.withText(item, text.slice(0, remaining)))

    if (!marked) bounded.push(input.makeMarker())
    remaining = 0
    marked = true
  }

  if (!marked) bounded.push(input.makeMarker())

  return bounded
}

const extensionForMime = (mimeType: string): string => {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? ""

  switch (normalized) {
    case "image/png":
      return ".png"
    case "image/jpeg":
      return ".jpg"
    case "image/gif":
      return ".gif"
    case "image/webp":
      return ".webp"
    case "image/svg+xml":
      return ".svg"
    case "application/pdf":
      return ".pdf"
    case "application/json":
      return ".json"
    case "text/plain":
      return ".txt"
    case "text/markdown":
      return ".md"
    case "text/html":
      return ".html"
    default:
      return ".bin"
  }
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
  readonly save: (bytes: Uint8Array, extension: string, directory?: string) => Effect.Effect<string>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("vibest/ToolOutput") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const layout = yield* Layout
    const defaultDir = path.join(layout.home, DIRECTORY)
    const cleanupFibers = yield* FiberSet.makeRuntime<never, void, never>()
    const state = { lastCleanupAt: yield* Clock.currentTimeMillis }

    const cleanup = Effect.fn("ToolOutput.cleanup")(function* (): Effect.fn.Return<void> {
      const entries = yield* fs.readDirectory(defaultDir).pipe(
        Effect.map((items) => items.filter((entry) => entry.startsWith("tool_"))),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      )

      if (entries.length === 0) return
      const cutoff = (yield* Clock.currentTimeMillis) - RETENTION_MS

      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const fullPath = path.join(defaultDir, entry)
            const info = yield* fs.stat(fullPath)

            if (Option.isSome(info.mtime) && info.mtime.value.getTime() < cutoff) {
              yield* fs.remove(fullPath, { force: true })
            }
          }).pipe(Effect.ignore),
        { concurrency: CLEANUP_CONCURRENCY, discard: true },
      )
    })

    const maybeTriggerCleanup = Effect.fn("ToolOutput.maybeTriggerCleanup")(function* () {
      const now = yield* Clock.currentTimeMillis

      if (now - state.lastCleanupAt < CLEANUP_INTERVAL_MS) return
      state.lastCleanupAt = now
      cleanupFibers(cleanup().pipe(Effect.ignore))
    })

    yield* Effect.forkScoped(cleanup().pipe(Effect.ignore))

    const ensurePrivateDir = (dir: string) =>
      fs
        .makeDirectory(dir, { recursive: true, mode: 0o700 })
        .pipe(Effect.andThen(fs.chmod(dir, 0o700).pipe(Effect.ignore)))

    const save = Effect.fn("ToolOutput.save")(function* (
      bytes: Uint8Array,
      extension: string,
      directory?: string,
    ): Effect.fn.Return<string> {
      const targetDir = directory ?? defaultDir
      const now = yield* Clock.currentTimeMillis
      const rand = Math.random().toString(36).slice(2, 10)
      const normalizedExt = extension.startsWith(".") || extension === "" ? extension : `.${extension}`
      const file = path.join(targetDir, `tool_${now.toString(16)}_${rand}${normalizedExt}`)

      yield* ensurePrivateDir(targetDir).pipe(
        Effect.andThen(fs.writeFile(file, bytes, { mode: 0o600 })),
        Effect.andThen(fs.chmod(file, 0o600).pipe(Effect.ignore)),
        Effect.orDie,
      )

      yield* maybeTriggerCleanup()

      return file
    })

    const saveFullOutput = (dir: string, name: string, text: string) =>
      Effect.gen(function* () {
        const file = path.join(dir, name)

        const failure = yield* ensurePrivateDir(dir).pipe(
          Effect.andThen(fs.writeFileString(file, text, { mode: 0o600 })),
          Effect.andThen(fs.chmod(file, 0o600).pipe(Effect.ignore)),
          Effect.as(undefined),
          Effect.catch((error) =>
            Effect.logWarning("failed to save full tool output", { file, error: error.message }).pipe(
              Effect.as(error.message),
            ),
          ),
        )

        yield* maybeTriggerCleanup()

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
      const targetDir = input.scratchpadDir ?? defaultDir

      const normalizedContent: Array<Mcp.CallContent> = []
      let savedMediaFile: string | undefined

      for (const item of input.result.content) {
        if (item.type === "media") {
          const bytes = decodeBase64(item.data)
          const savedPath = yield* save(bytes, extensionForMime(item.mimeType), targetDir)
          savedMediaFile ??= savedPath
          normalizedContent.push({
            type: "text",
            text: `[Binary resource (${item.mimeType}, ${bytes.byteLength} bytes) saved to ${savedPath}]`,
          })
          continue
        }

        normalizedContent.push(item)
      }

      const textParts = normalizedContent.flatMap((item) => (item.type === "text" ? [item.text] : []))
      const baseText = joinParts(textParts)

      const structuredText =
        input.result.structured !== undefined ? JSON.stringify(input.result.structured, null, 2) : undefined

      const structuredFits =
        structuredText === undefined ||
        (countLines(baseText) + countLines(structuredText) <= maxLines &&
          utf8ByteLength(baseText) + utf8ByteLength(structuredText) <= maxBytes)

      if (countLines(baseText) <= maxLines && utf8ByteLength(baseText) <= maxBytes && structuredFits) {
        return {
          ...input.result,
          content: normalizedContent,
          truncated: false,
          ...(savedMediaFile !== undefined && { outputFile: savedMediaFile }),
        }
      }

      const contentForSlice: ReadonlyArray<Mcp.CallContent> =
        structuredText !== undefined
          ? [...normalizedContent, { type: "text", text: structuredText }]
          : normalizedContent

      const text = structuredText !== undefined ? joinParts([...textParts, structuredText]) : baseText
      const totalLines = countLines(text)
      const end = Math.min(afterLines(text, maxLines), byteBoundary(text, maxBytes))
      const shown = stripTrailingLineBreak(text, end)
      const now = yield* Clock.currentTimeMillis
      const rand = Math.random().toString(36).slice(2, 10)
      const name = `tool_${now.toString(16)}_${sanitizeSegment(input.server)}_${sanitizeSegment(input.tool)}_${rand}.txt`
      const { file, failure } = yield* saveFullOutput(targetDir, name, text)
      const marker = formatMarker(text, end, shown, totalLines, file, failure)

      const bounded = sliceTextItems({
        items: contentForSlice,
        shownLength: shown.length,
        getText: (item) => (item.type === "text" ? item.text : undefined),
        withText: (_item, sliced): Mcp.CallContent => ({ type: "text", text: sliced }),
        makeMarker: (): Mcp.CallContent => ({ type: "text", text: marker }),
      })

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
      const targetDir = input.scratchpadDir ?? defaultDir

      const normalizedContents: Array<Mcp.ResourceContent> = []
      let savedBlobFile: string | undefined

      for (const item of input.result.contents) {
        if (item.blob !== undefined) {
          const mimeType = item.mimeType ?? "application/octet-stream"
          const bytes = decodeBase64(item.blob)
          const savedPath = yield* save(bytes, extensionForMime(mimeType), targetDir)
          savedBlobFile ??= savedPath
          normalizedContents.push({
            uri: item.uri,
            mimeType: "text/plain",
            text: `[Binary resource (${mimeType}, ${bytes.byteLength} bytes) saved to ${savedPath}]`,
          })
          continue
        }

        normalizedContents.push(item)
      }

      const textParts = normalizedContents.flatMap((item) => (item.text !== undefined ? [item.text] : []))
      const text = joinParts(textParts)
      const totalLines = countLines(text)

      if (totalLines <= maxLines && utf8ByteLength(text) <= maxBytes) {
        return {
          ...input.result,
          contents: normalizedContents,
          truncated: false,
          ...(savedBlobFile !== undefined && { outputFile: savedBlobFile }),
        }
      }

      const end = Math.min(afterLines(text, maxLines), byteBoundary(text, maxBytes))
      const shown = stripTrailingLineBreak(text, end)
      const now = yield* Clock.currentTimeMillis
      const rand = Math.random().toString(36).slice(2, 10)
      const name = `tool_${now.toString(16)}_${sanitizeSegment(input.server)}_resource_${rand}.txt`
      const { file, failure } = yield* saveFullOutput(targetDir, name, text)
      const marker = formatMarker(text, end, shown, totalLines, file, failure)

      const bounded = sliceTextItems({
        items: normalizedContents,
        shownLength: shown.length,
        getText: (item) => item.text,
        withText: (item, sliced) => ({ ...item, text: sliced }),
        makeMarker: () => ({ uri: input.result.uri, mimeType: "text/plain", text: marker }),
      })

      return {
        uri: input.result.uri,
        contents: bounded,
        truncated: true,
        ...(failure === undefined && { outputFile: file }),
      }
    })

    return Service.of({ truncateCallResult, truncateResourceResult, save, cleanup })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [PlatformNode.fileSystem, PlatformNode.path, PlatformNode.layout],
})
