import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import url from "node:url"

import { Option, Predicate, Schema } from "effect"

import { injectHtmlPreviewBridge } from "./preview-bridge.ts"
import {
  isValidProjectId,
  readProjectTextFile,
  resolveSafeProjectFilePath,
  writeProjectTextFile,
} from "./project-files.ts"
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
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  })
}

function decodeRouteParam(raw: string | undefined): string | null {
  if (raw === undefined) return null

  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

function allowedLoopbackHosts(boundPort: number): ReadonlySet<string> {
  return new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`])
}

function allowedLoopbackOrigins(boundPort: number): ReadonlySet<string> {
  return new Set([`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`, `http://[::1]:${boundPort}`])
}

function isAllowedHost(request: Request, boundPort: number): boolean {
  const host = request.headers.get("host")

  if (!host) return false

  return allowedLoopbackHosts(boundPort).has(host.toLowerCase())
}

function isAllowedMutationOrigin(request: Request, boundPort: number): boolean {
  const origin = request.headers.get("origin")

  if (origin !== null) {
    return allowedLoopbackOrigins(boundPort).has(origin.toLowerCase())
  }

  return request.headers.get("sec-fetch-site") === "same-origin"
}

function hasJsonContentType(request: Request): boolean {
  const ct = request.headers.get("content-type") ?? ""

  return ct.toLowerCase().split(";")[0]?.trim() === "application/json"
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

  return new Response(fs.readFileSync(candidate), {
    headers: { "content-type": contentTypeFor(candidate), "x-content-type-options": "nosniff" },
  })
}

function readNodeRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", reject)
  })
}

async function toWebRequest(req: http.IncomingMessage, fallbackHost: string, signal: AbortSignal): Promise<Request> {
  const method = req.method ?? "GET"
  const host = req.headers.host ?? fallbackHost
  const targetUrl = `http://${host}${req.url ?? "/"}`
  const headers = new Headers()

  for (const [key, val] of Object.entries(req.headers)) {
    if (Array.isArray(val)) {
      for (const item of val) {
        headers.append(key, item)
      }
    } else if (val !== undefined) {
      headers.set(key, val)
    }
  }

  if (method === "GET" || method === "HEAD") {
    return new Request(targetUrl, { method, headers, signal })
  }

  const body = await readNodeRequestBody(req)

  return new Request(targetUrl, { method, headers, body, signal })
}

async function writeWebResponse(res: http.ServerResponse, response: Response): Promise<void> {
  const headerObj: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headerObj[key] = value
  })
  res.writeHead(response.status, headerObj)

  if (!response.body) {
    res.end()

    return
  }

  const reader = response.body.getReader()

  try {
    while (true) {
      const next = await reader.read()

      if (next.done) break
      res.write(next.value)
    }
  } catch {
    return
  } finally {
    reader.releaseLock()

    if (!res.writableEnded) res.end()
  }
}

export async function createWebServer(options: WebServerOptions = {}): Promise<RunningWebServer> {
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

  const host = options.host ?? "127.0.0.1"
  const bound = { port: options.port ?? Number(process.env.PORT ?? "4320") }

  const handleFetch = async (request: Request): Promise<Response> => {
    const reqUrl = new URL(request.url)
    const pathname = reqUrl.pathname

    if (pathname.startsWith("/api/")) {
      if (!isAllowedHost(request, bound.port)) {
        return jsonResponse({ error: "Forbidden host" }, 403)
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        if (!isAllowedMutationOrigin(request, bound.port)) {
          return jsonResponse({ error: "Forbidden origin" }, 403)
        }
      }
    }

    if (request.method === "GET" && pathname === "/api/health") {
      return jsonResponse({ ok: true, daemon: bridge.snapshot().daemon })
    }

    if (request.method === "GET" && pathname === "/api/state") {
      return jsonResponse(bridge.snapshot())
    }

    if (request.method === "GET" && pathname === "/api/stream") {
      const encoder = new TextEncoder()
      let unsubscribe: (() => void) | null = null
      let keepalive: ReturnType<typeof setInterval> | null = null

      const cleanup = () => {
        if (keepalive !== null) {
          clearInterval(keepalive)
          keepalive = null
        }

        if (unsubscribe !== null) {
          unsubscribe()
          unsubscribe = null
        }
      }

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
              cleanup()
            }
          })

          keepalive = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"))
            } catch {
              cleanup()
            }
          }, 25_000)

          request.signal.addEventListener("abort", cleanup, { once: true })
        },
        cancel() {
          cleanup()
        },
      })

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-content-type-options": "nosniff",
        },
      })
    }

    const timelineMatch = /^\/api\/projects\/([^/]+)\/timeline$/.exec(pathname)

    if (request.method === "GET" && timelineMatch) {
      const projectId = decodeRouteParam(timelineMatch[1])

      if (projectId === null || !isValidProjectId(projectId)) {
        return jsonResponse({ error: "Invalid project id" }, 400)
      }

      const sessionId = reqUrl.searchParams.get("sessionId") ?? ""
      const entries = await bridge.getTimeline(projectId, sessionId)

      return jsonResponse({ projectId, sessionId, entries })
    }

    const filesListMatch = /^\/api\/projects\/([^/]+)\/files$/.exec(pathname)

    if (request.method === "GET" && filesListMatch) {
      const projectId = decodeRouteParam(filesListMatch[1])

      if (projectId === null || !isValidProjectId(projectId)) {
        return jsonResponse({ error: "Invalid project id" }, 400)
      }

      const files = bridge.refreshFiles(projectId)

      return jsonResponse({ projectId, files })
    }

    const fileItemMatch = /^\/api\/projects\/([^/]+)\/file$/.exec(pathname)

    if (request.method === "GET" && fileItemMatch) {
      const projectId = decodeRouteParam(fileItemMatch[1])

      if (projectId === null || !isValidProjectId(projectId)) {
        return jsonResponse({ error: "Invalid project id" }, 400)
      }

      const relPath = reqUrl.searchParams.get("path") ?? ""
      const rawMode = reqUrl.searchParams.get("raw") === "1"

      if (rawMode) {
        const abs = resolveSafeProjectFilePath(vibestHome, projectId, relPath)

        if (abs === null || !fs.existsSync(abs)) {
          return jsonResponse({ error: "File not found" }, 404)
        }

        return new Response(fs.readFileSync(abs), {
          headers: {
            "content-type": contentTypeFor(abs),
            "content-security-policy": "sandbox",
            "x-content-type-options": "nosniff",
          },
        })
      }

      const content = readProjectTextFile(vibestHome, projectId, relPath)

      if (content === null) {
        return jsonResponse({ error: "File not found" }, 404)
      }

      return jsonResponse({ projectId, path: relPath, content })
    }

    if (request.method === "PUT" && fileItemMatch) {
      const projectId = decodeRouteParam(fileItemMatch[1])

      if (projectId === null || !isValidProjectId(projectId)) {
        return jsonResponse({ error: "Invalid project id" }, 400)
      }

      if (!hasJsonContentType(request)) {
        return jsonResponse({ error: "Content-Type must be application/json" }, 415)
      }

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
      const projectId = decodeRouteParam(previewMatch[1])

      if (projectId === null || !isValidProjectId(projectId)) {
        return jsonResponse({ error: "Invalid project id" }, 400)
      }

      const relPath = reqUrl.searchParams.get("path") ?? ""
      const content = readProjectTextFile(vibestHome, projectId, relPath)

      if (content === null) {
        return new Response("Not found", { status: 404 })
      }

      return new Response(injectHtmlPreviewBridge(content), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "sandbox allow-scripts",
          "x-content-type-options": "nosniff",
        },
      })
    }

    const peekMatch = /^\/api\/sessions\/([^/]+)\/peek$/.exec(pathname)

    if (request.method === "GET" && peekMatch) {
      const sessionId = decodeRouteParam(peekMatch[1])

      if (sessionId === null) {
        return jsonResponse({ error: "Invalid session id" }, 400)
      }

      const result = await bridge.peekSession(sessionId)

      return jsonResponse(result)
    }

    const sendMatch = /^\/api\/sessions\/([^/]+)\/send$/.exec(pathname)

    if (request.method === "POST" && sendMatch) {
      const sessionId = decodeRouteParam(sendMatch[1])

      if (sessionId === null) {
        return jsonResponse({ error: "Invalid session id" }, 400)
      }

      if (!hasJsonContentType(request)) {
        return jsonResponse({ error: "Content-Type must be application/json" }, 415)
      }

      const decoded = await decodeRequestJson(request, decodeSendBody)

      if (Option.isNone(decoded)) {
        return jsonResponse({ error: "Invalid send payload" }, 400)
      }

      const result = await bridge.sendToSession(sessionId, decoded.value.message, decoded.value.attachments ?? [])

      return jsonResponse(result, result.ok ? 200 : 400)
    }

    const interruptMatch = /^\/api\/sessions\/([^/]+)\/interrupt$/.exec(pathname)

    if (request.method === "POST" && interruptMatch) {
      const sessionId = decodeRouteParam(interruptMatch[1])

      if (sessionId === null) {
        return jsonResponse({ error: "Invalid session id" }, 400)
      }

      const result = await bridge.interruptSession(sessionId)

      return jsonResponse(result, result.ok ? 200 : 400)
    }

    const archiveMatch = /^\/api\/sessions\/([^/]+)\/archive$/.exec(pathname)

    if (request.method === "POST" && archiveMatch) {
      const sessionId = decodeRouteParam(archiveMatch[1])

      if (sessionId === null) {
        return jsonResponse({ error: "Invalid session id" }, 400)
      }

      const result = await bridge.archiveSession(sessionId)

      return jsonResponse(result, result.ok ? 200 : 400)
    }

    const staticResponse = serveStaticFile(distDir, pathname)

    if (staticResponse) return staticResponse

    const indexFallback = serveStaticFile(distDir, "/index.html")

    if (indexFallback) return indexFallback

    return new Response("Not found", { status: 404 })
  }

  const server = http.createServer((req, res) => {
    const abortController = new AbortController()
    req.on("close", () => abortController.abort())

    void toWebRequest(req, `${host}:${bound.port}`, abortController.signal)
      .then((webReq) => handleFetch(webReq))
      .then((webRes) => writeWebResponse(res, webRes))
      .catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" })
        }

        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: "Internal server error" }))
        }
      })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(bound.port, host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const addr = server.address()

  if (addr !== null && !Predicate.isString(addr)) {
    bound.port = addr.port
  }

  return {
    port: bound.port,
    url: `http://${host}:${bound.port}`,
    stop: () => {
      bridge.stop()
      server.closeAllConnections()
      server.close()
    },
  }
}

if (import.meta.main) {
  void createWebServer().then((started) => {
    console.log(`vibest-web listening on ${started.url}`)
  })
}
