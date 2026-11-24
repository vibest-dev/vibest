import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import url from "node:url"

import { Option, Schema } from "effect"

import { injectHtmlPreviewBridge } from "./preview-bridge.ts"
import { readProjectTextFile, resolveSafeProjectFilePath, writeProjectTextFile } from "./project-files.ts"
import type { StreamPayload } from "./types.ts"
import { createVibestBridge } from "./vibest-bridge.ts"

const MODULE_DIR = path.dirname(url.fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(MODULE_DIR, "..")
const DIST_DIR = path.join(APP_ROOT, "dist")

const SendBodySchema = Schema.Struct({
  message: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.String)),
})

const SaveFileBodySchema = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
})

const decodeSendBody = Schema.decodeUnknownOption(Schema.fromJsonString(SendBodySchema))
const decodeSaveFileBody = Schema.decodeUnknownOption(Schema.fromJsonString(SaveFileBodySchema))

export interface WebServerOptions {
  readonly port?: number
  readonly host?: string
  readonly vibestHome?: string
  readonly repositoryRoot?: string
  readonly demoMode?: boolean
  readonly safeActions?: boolean
  readonly distDir?: string
}

export interface RunningWebServer {
  readonly port: number
  readonly url: string
  readonly stop: () => void
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()

  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8"
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8"
    case ".css":
      return "text/css; charset=utf-8"
    case ".json":
      return "application/json; charset=utf-8"
    case ".svg":
      return "image/svg+xml"
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".webp":
      return "image/webp"
    case ".mp4":
      return "video/mp4"
    case ".woff2":
      return "font/woff2"
    case ".wasm":
      return "application/wasm"
    default:
      return "application/octet-stream"
  }
}

function jsonResponse<T>(payload: T, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
}

async function decodeRequestJson<A>(
  request: Request,
  decode: (input: string) => Option.Option<A>,
): Promise<Option.Option<A>> {
  try {
    const raw = await request.text()

    return decode(raw)
  } catch {
    return Option.none()
  }
}

function serveStaticFile(distDir: string, pathname: string): Response | null {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const normalized = path.posix.normalize(rel)

  if (normalized.startsWith("..")) return null

  const candidate = path.resolve(distDir, normalized)

  if (!candidate.startsWith(`${path.resolve(distDir)}${path.sep}`)) return null

  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null

  return new Response(Bun.file(candidate), {
    headers: { "content-type": contentTypeFor(candidate) },
  })
}

export function createWebServer(options: WebServerOptions = {}): RunningWebServer {
  const vibestHome = options.vibestHome ?? process.env.VIBEST_HOME ?? path.join(os.homedir(), ".vibest")
  const repositoryRoot = options.repositoryRoot ?? process.cwd()
  const distDir = options.distDir ?? DIST_DIR
  const demoMode = options.demoMode ?? process.env.VIBEST_WEB_DEMO === "1"
  const safeActions = options.safeActions ?? process.env.VIBEST_WEB_SAFE === "1"

  const bridge = createVibestBridge({
    vibestHome,
    repositoryRoot,
    demoMode,
    safeActions,
  })

  const server = Bun.serve({
    hostname: options.host ?? "127.0.0.1",
    port: options.port ?? Number(process.env.PORT ?? "4320"),
    idleTimeout: 120,
    fetch: async (request) => {
      const reqUrl = new URL(request.url)
      const pathname = reqUrl.pathname

      if (request.method === "GET" && pathname === "/api/health") {
        return jsonResponse({ ok: true, daemon: bridge.snapshot().daemon })
      }

      if (request.method === "GET" && pathname === "/api/state") {
        return jsonResponse(bridge.snapshot())
      }

      if (request.method === "GET" && pathname === "/api/stream") {
        const encoder = new TextEncoder()
        let unsubscribe: (() => void) | null = null

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const writeEvent = (payload: StreamPayload) => {
              const chunk = `event: ${payload.type}\ndata: ${JSON.stringify(payload.data)}\n\n`
              controller.enqueue(encoder.encode(chunk))
            }

            writeEvent({ type: "snapshot", data: bridge.snapshot() })
            unsubscribe = bridge.subscribe((event) => {
              try {
                writeEvent(event)
              } catch {
                unsubscribe?.()
              }
            })
          },
          cancel() {
            unsubscribe?.()
          },
        })

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        })
      }

      const timelineMatch = /^\/api\/projects\/([^/]+)\/timeline$/.exec(pathname)

      if (request.method === "GET" && timelineMatch) {
        const projectId = decodeURIComponent(timelineMatch[1] ?? "")
        const sessionId = reqUrl.searchParams.get("sessionId") ?? ""
        const entries = await bridge.getTimeline(projectId, sessionId)

        return jsonResponse({ projectId, sessionId, entries })
      }

      const filesListMatch = /^\/api\/projects\/([^/]+)\/files$/.exec(pathname)

      if (request.method === "GET" && filesListMatch) {
        const projectId = decodeURIComponent(filesListMatch[1] ?? "")
        const files = bridge.refreshFiles(projectId)

        return jsonResponse({ projectId, files })
      }

      const fileItemMatch = /^\/api\/projects\/([^/]+)\/file$/.exec(pathname)

      if (request.method === "GET" && fileItemMatch) {
        const projectId = decodeURIComponent(fileItemMatch[1] ?? "")
        const relPath = reqUrl.searchParams.get("path") ?? ""
        const rawMode = reqUrl.searchParams.get("raw") === "1"

        if (rawMode) {
          const abs = resolveSafeProjectFilePath(vibestHome, projectId, relPath)

          if (abs === null || !fs.existsSync(abs)) {
            return jsonResponse({ error: "File not found" }, 404)
          }

          return new Response(Bun.file(abs), {
            headers: { "content-type": contentTypeFor(abs) },
          })
        }

        const content = readProjectTextFile(vibestHome, projectId, relPath)

        if (content === null) {
          return jsonResponse({ error: "File not found" }, 404)
        }

        return jsonResponse({ projectId, path: relPath, content })
      }

      if (request.method === "PUT" && fileItemMatch) {
        const projectId = decodeURIComponent(fileItemMatch[1] ?? "")
        const decoded = await decodeRequestJson(request, decodeSaveFileBody)

        if (Option.isNone(decoded)) {
          return jsonResponse({ error: "Invalid file save payload" }, 400)
        }

        const saved = writeProjectTextFile(vibestHome, projectId, decoded.value.path, decoded.value.content)

        if (!saved) {
          return jsonResponse({ error: "Invalid target path" }, 400)
        }

        const files = bridge.refreshFiles(projectId)

        return jsonResponse({ ok: true, path: decoded.value.path, files })
      }

      const previewMatch = /^\/api\/projects\/([^/]+)\/preview$/.exec(pathname)

      if (request.method === "GET" && previewMatch) {
        const projectId = decodeURIComponent(previewMatch[1] ?? "")
        const relPath = reqUrl.searchParams.get("path") ?? ""
        const content = readProjectTextFile(vibestHome, projectId, relPath)

        if (content === null) {
          return new Response("Not found", { status: 404 })
        }

        return new Response(injectHtmlPreviewBridge(content), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        })
      }

      const peekMatch = /^\/api\/sessions\/([^/]+)\/peek$/.exec(pathname)

      if (request.method === "GET" && peekMatch) {
        const sessionId = decodeURIComponent(peekMatch[1] ?? "")
        const result = await bridge.peekSession(sessionId)

        return jsonResponse(result)
      }

      const sendMatch = /^\/api\/sessions\/([^/]+)\/send$/.exec(pathname)

      if (request.method === "POST" && sendMatch) {
        const sessionId = decodeURIComponent(sendMatch[1] ?? "")
        const decoded = await decodeRequestJson(request, decodeSendBody)

        if (Option.isNone(decoded)) {
          return jsonResponse({ error: "Invalid send payload" }, 400)
        }

        const result = await bridge.sendToSession(sessionId, decoded.value.message, decoded.value.attachments ?? [])

        return jsonResponse(result, result.ok ? 200 : 400)
      }

      const interruptMatch = /^\/api\/sessions\/([^/]+)\/interrupt$/.exec(pathname)

      if (request.method === "POST" && interruptMatch) {
        const sessionId = decodeURIComponent(interruptMatch[1] ?? "")
        const result = await bridge.interruptSession(sessionId)

        return jsonResponse(result, result.ok ? 200 : 400)
      }

      const archiveMatch = /^\/api\/sessions\/([^/]+)\/archive$/.exec(pathname)

      if (request.method === "POST" && archiveMatch) {
        const sessionId = decodeURIComponent(archiveMatch[1] ?? "")
        const result = await bridge.archiveSession(sessionId)

        return jsonResponse(result, result.ok ? 200 : 400)
      }

      const staticResponse = serveStaticFile(distDir, pathname)

      if (staticResponse) return staticResponse

      const indexFallback = serveStaticFile(distDir, "/index.html")

      if (indexFallback) return indexFallback

      return new Response("Not found", { status: 404 })
    },
  })

  const boundPort = server.port ?? 4320

  return {
    port: boundPort,
    url: `http://${server.hostname}:${boundPort}`,
    stop: () => {
      bridge.stop()
      void server.stop(true)
    },
  }
}

if (import.meta.main) {
  const started = createWebServer()
  console.log(`vibest-web listening on ${started.url}`)
}
