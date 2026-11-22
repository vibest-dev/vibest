import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import url from "node:url"

import { z } from "zod"

import { buildClientAssets } from "./build-client.ts"
import { HubDatabase } from "./database.ts"
import { generateArchitectureScene, type ArchitecturePreset } from "./excalidraw-templates.ts"
import { injectHtmlPreviewBridge } from "./preview-bridge.ts"
import {
  ArtifactKindSchema,
  ArtifactMetadataSchema,
  CommentAnchorSchema,
  DecisionQuestionSchema,
  ReviewStatusSchema,
  ReviewVerdictSchema,
  SessionStatusSchema,
  TaskStatusSchema,
} from "./schema.ts"
import { seedDefaultDemoProject } from "./seed.ts"
import { importVibestProjectReadOnly } from "./vibest-import.ts"

const MODULE_DIR = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(MODULE_DIR, "..")

const EXCALIDRAW_PROD_DIR = path.join(ROOT_DIR, "node_modules", "@excalidraw", "excalidraw", "dist", "prod")

const CreateProjectBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  repoPath: z.string().optional(),
  entrySessionId: z.string().optional(),
})

const ImportVibestBodySchema = z.object({
  name: z.string().optional(),
  vibestProjectDir: z.string().min(1),
  vibestDbPath: z.string().optional(),
})

const CreateTaskBodySchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default("Active workstream"),
  branch: z.string().optional(),
  prUrl: z.string().optional(),
  sessionIds: z.array(z.string()).optional(),
})

const UpdateTaskBodySchema = z.object({
  title: z.string().optional(),
  status: TaskStatusSchema.optional(),
  summary: z.string().optional(),
  branch: z.string().optional(),
  prUrl: z.string().optional(),
  sessionIds: z.array(z.string()).optional(),
})

const UpdateSessionStatusBodySchema = z.object({
  status: SessionStatusSchema,
  blockedReason: z.string().optional(),
})

const CreateArtifactBodySchema = z.object({
  projectId: z.string().min(1),
  taskId: z.string().optional(),
  slug: z.string().optional(),
  title: z.string().min(1),
  kind: ArtifactKindSchema,
  summary: z.string().default(""),
  content: z.string(),
  reviewStatus: ReviewStatusSchema.default("requested"),
  questions: z.array(DecisionQuestionSchema).optional(),
  metadata: ArtifactMetadataSchema.optional(),
  authorSessionId: z.string().optional(),
  extraFiles: z
    .array(
      z.object({
        fileName: z.string(),
        content: z.string(),
      }),
    )
    .optional(),
})

const SaveContentBodySchema = z.object({
  content: z.string(),
  publishNewVersion: z.boolean().optional(),
  summary: z.string().optional(),
  requestReview: z.boolean().optional(),
})

const GenerateWhiteboardBodySchema = z.object({
  preset: z.enum(["vibest-architecture", "event-pipeline", "multi-agent-review"]),
})

const SelectVariantBodySchema = z.object({
  selectedVariantId: z.string().min(1),
})

const AnswerQuestionBodySchema = z.object({
  questionId: z.string().min(1),
  selectedOptionIds: z.array(z.string()),
})

const CreateCommentBodySchema = z.object({
  author: z.string().optional(),
  body: z.string().min(1),
  anchor: CommentAnchorSchema,
})

const ReplyCommentBodySchema = z.object({
  author: z.string().optional(),
  body: z.string().min(1),
})

const ResolveCommentBodySchema = z.object({
  resolved: z.boolean(),
})

const SubmitReviewBodySchema = z.object({
  verdict: ReviewVerdictSchema,
  reviewerNote: z.string().optional(),
  answers: z.record(z.string(), z.array(z.string())).optional(),
  deliverViaVibestSend: z.boolean().optional(),
  overrideTargetSessionId: z.string().optional(),
})

const SaveKnowledgeBodySchema = z.object({
  relativePath: z.string().min(1),
  content: z.string(),
})

function jsonResponse<T>(payload: T, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

function errorResponse(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])

function isAllowedRequestOrigin(originHeader: string, requestUrl: URL, boundHostname: string): boolean {
  if (originHeader === "null" || originHeader.trim().length === 0) {
    return false
  }

  try {
    const parsedOrigin = new URL(originHeader)

    if (parsedOrigin.origin !== requestUrl.origin) {
      return false
    }

    return LOOPBACK_HOSTS.has(parsedOrigin.hostname) || parsedOrigin.hostname === boundHostname
  } catch {
    return false
  }
}

function isStateMutatingMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE"
}

function contentTypeForPath(filePath: string): string {
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
    case ".map":
      return "application/json; charset=utf-8"
    case ".woff2":
      return "font/woff2"
    case ".woff":
      return "font/woff"
    case ".ttf":
      return "font/ttf"
    case ".svg":
      return "image/svg+xml"
    case ".png":
      return "image/png"
    default:
      return "application/octet-stream"
  }
}

interface VibestDeliveryResult {
  attempted: boolean
  delivered: boolean
  detail: string
}

function tryDeliverVibestSend(targetSessionId: string, payload: string): VibestDeliveryResult {
  const vibestCli =
    process.env.VIBEST_CLI ?? "/Users/dinq/.bun/install/global/node_modules/@vibest/cli-darwin-arm64/bin/vibest"

  if (!fs.existsSync(vibestCli)) {
    return {
      attempted: true,
      delivered: false,
      detail: `vibest binary not found at ${vibestCli}`,
    }
  }

  const proc = childProcess.spawnSync(vibestCli, ["send", targetSessionId, "--", payload], {
    encoding: "utf8",
    timeout: 5000,
  })

  if (proc.status === 0) {
    return {
      attempted: true,
      delivered: true,
      detail: `Sent via vibest send to ${targetSessionId}`,
    }
  }

  return {
    attempted: true,
    delivered: false,
    detail: (proc.stderr || proc.stdout || "vibest send exited non-zero").trim(),
  }
}

export interface RunningHubServer {
  readonly server: ReturnType<typeof Bun.serve>
  readonly hubDb: HubDatabase
  readonly url: string
  stop(): void
}

export async function createHubServer(options?: {
  port?: number
  hostname?: string
  dataDir?: string
  skipClientBuild?: boolean
}): Promise<RunningHubServer> {
  const port = options?.port ?? Number(process.env.PORT ?? 4310)
  const hostname = options?.hostname ?? process.env.HOST ?? "127.0.0.1"
  const dataDir = path.resolve(options?.dataDir ?? process.env.HUB_DATA_DIR ?? path.join(ROOT_DIR, ".data"))

  const distDir = options?.skipClientBuild ? path.join(ROOT_DIR, "dist") : await buildClientAssets()

  const hubDb = new HubDatabase(dataDir)
  seedDefaultDemoProject(hubDb)

  const wsClients = new Set<Bun.ServerWebSocket<{ connectedAt: number }>>()

  const broadcastJson = (message: string) => {
    for (const ws of wsClients) {
      try {
        ws.send(message)
      } catch {
        wsClients.delete(ws)
      }
    }
  }

  const unsubscribeDb = hubDb.subscribe((event) => {
    broadcastJson(
      JSON.stringify({
        kind: "hub.event",
        event,
      }),
    )
  })

  const detectedVibestProjectDir = process.env.VIBEST_PROJECT_DIR ?? undefined

  const server = Bun.serve<{ connectedAt: number }>({
    port,
    hostname,
    idleTimeout: 120,
    fetch: async (req, bunServer) => {
      const parsedUrl = new URL(req.url)
      const pathname = parsedUrl.pathname
      const method = req.method
      const originHeader = req.headers.get("origin")

      if (pathname === "/ws") {
        if (originHeader !== null && !isAllowedRequestOrigin(originHeader, parsedUrl, hostname)) {
          return errorResponse("Cross-origin WebSocket rejected", 403)
        }

        const upgraded = bunServer.upgrade(req, {
          data: { connectedAt: Date.now() },
        })

        if (upgraded) return undefined

        return errorResponse("WebSocket upgrade failed", 400)
      }

      if (pathname.startsWith("/api/") && isStateMutatingMethod(method)) {
        if (originHeader !== null && !isAllowedRequestOrigin(originHeader, parsedUrl, hostname)) {
          return errorResponse("Cross-origin mutation rejected", 403)
        }

        const contentType = (req.headers.get("content-type") ?? "").toLowerCase()

        if (!contentType.startsWith("application/json")) {
          return errorResponse("Content-Type must be application/json", 415)
        }
      }

      try {
        if (pathname === "/api/health" && method === "GET") {
          return jsonResponse({
            ok: true,
            projects: hubDb.listProjects().length,
            detectedVibestProjectDir: detectedVibestProjectDir ?? null,
          })
        }

        if (pathname === "/api/notify-reload" && method === "POST") {
          broadcastJson(JSON.stringify({ kind: "hub.external_reload", at: Date.now() }))

          return jsonResponse({ ok: true })
        }

        if (pathname === "/api/projects" && method === "GET") {
          const projects = hubDb.listProjects().map((p) => {
            const board = hubDb.getBoard(p.id)

            return {
              ...p,
              needsYouCount: board.needsYou.length,
              inProgressCount: board.inProgress.length,
            }
          })

          return jsonResponse({
            projects,
            detectedVibestProjectDir: detectedVibestProjectDir ?? null,
          })
        }

        if (pathname === "/api/projects" && method === "POST") {
          const body = CreateProjectBodySchema.parse(await req.json())
          const created = hubDb.createProject(body)
          hubDb.writeKnowledgeFile(
            created.id,
            "preferences.md",
            `# ${created.name} Preferences\n\n- Event-sourced project managed in Vibest Hub.\n`,
          )

          return jsonResponse({ project: created }, 201)
        }

        if (pathname === "/api/projects/import-vibest" && method === "POST") {
          const body = ImportVibestBodySchema.parse(await req.json())
          const result = importVibestProjectReadOnly(hubDb, body)

          return jsonResponse(result, 201)
        }

        const projectBoardMatch = /^\/api\/projects\/([^/]+)\/board$/.exec(pathname)

        if (projectBoardMatch && method === "GET") {
          const projectId = decodeURIComponent(projectBoardMatch[1] ?? "")

          return jsonResponse(hubDb.getBoard(projectId))
        }

        const projectArtifactsMatch = /^\/api\/projects\/([^/]+)\/artifacts$/.exec(pathname)

        if (projectArtifactsMatch && method === "GET") {
          const projectId = decodeURIComponent(projectArtifactsMatch[1] ?? "")
          const project = hubDb.getProject(projectId)

          if (!project) return errorResponse(`Project not found: ${projectId}`, 404)

          const artifacts = hubDb.listArtifacts(project.id).map((art) => ({
            ...art,
            openCommentCount: hubDb.listCommentThreads(art.id).flatMap((t) => (t.resolved ? [] : [t])).length,
          }))

          return jsonResponse({ artifacts })
        }

        const projectSessionsMatch = /^\/api\/projects\/([^/]+)\/sessions$/.exec(pathname)

        if (projectSessionsMatch && method === "GET") {
          const projectId = decodeURIComponent(projectSessionsMatch[1] ?? "")
          const project = hubDb.getProject(projectId)

          if (!project) return errorResponse(`Project not found: ${projectId}`, 404)
          const board = hubDb.getBoard(project.id)

          return jsonResponse({
            sessions: hubDb.listSessions(project.id),
            tasks: hubDb.listTasks(project.id),
            sessionFactsMarkdown: board.sessionFactsMarkdown,
          })
        }

        const projectEventsMatch = /^\/api\/projects\/([^/]+)\/events$/.exec(pathname)

        if (projectEventsMatch && method === "GET") {
          return jsonResponse({ events: hubDb.listEvents(60) })
        }

        const projectKnowledgeMatch = /^\/api\/projects\/([^/]+)\/knowledge$/.exec(pathname)

        if (projectKnowledgeMatch && method === "GET") {
          const projectId = decodeURIComponent(projectKnowledgeMatch[1] ?? "")
          const project = hubDb.getProject(projectId)

          if (!project) return errorResponse(`Project not found: ${projectId}`, 404)
          const fileParam = parsedUrl.searchParams.get("file")

          if (fileParam) {
            return jsonResponse({
              relativePath: fileParam,
              content: hubDb.readKnowledgeFile(project.id, fileParam),
            })
          }

          return jsonResponse({
            files: hubDb.listKnowledgeFiles(project.id),
          })
        }

        if (projectKnowledgeMatch && method === "PUT") {
          const projectId = decodeURIComponent(projectKnowledgeMatch[1] ?? "")
          const project = hubDb.getProject(projectId)

          if (!project) return errorResponse(`Project not found: ${projectId}`, 404)
          const body = SaveKnowledgeBodySchema.parse(await req.json())
          const saved = hubDb.writeKnowledgeFile(project.id, body.relativePath, body.content)
          broadcastJson(
            JSON.stringify({
              kind: "hub.knowledge_saved",
              projectId: project.id,
              relativePath: saved.relativePath,
            }),
          )

          return jsonResponse({ entry: saved })
        }

        if (pathname === "/api/tasks" && method === "POST") {
          const body = CreateTaskBodySchema.parse(await req.json())
          const task = hubDb.createTask(body)

          return jsonResponse({ task }, 201)
        }

        const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname)

        if (taskMatch && method === "PATCH") {
          const taskId = decodeURIComponent(taskMatch[1] ?? "")
          const body = UpdateTaskBodySchema.parse(await req.json())
          const task = hubDb.updateTask(taskId, body)

          return jsonResponse({ task })
        }

        const sessionStatusMatch = /^\/api\/sessions\/([^/]+)\/status$/.exec(pathname)

        if (sessionStatusMatch && method === "PATCH") {
          const sessionId = decodeURIComponent(sessionStatusMatch[1] ?? "")
          const body = UpdateSessionStatusBodySchema.parse(await req.json())
          const session = hubDb.updateSessionStatus(sessionId, body.status, body.blockedReason)

          return jsonResponse({ session })
        }

        if (pathname === "/api/artifacts" && method === "POST") {
          const body = CreateArtifactBodySchema.parse(await req.json())
          const targetProject = hubDb.getProject(body.projectId)

          if (!targetProject) {
            return errorResponse(`Project not found: ${body.projectId}`, 404)
          }

          const content =
            body.kind === "whiteboard" && body.content.trim().length === 0
              ? generateArchitectureScene("vibest-architecture")
              : body.content

          const artifact = hubDb.putArtifact({
            ...body,
            projectId: targetProject.id,
            content,
          })

          return jsonResponse({ artifact }, 201)
        }

        const artifactDetailMatch = /^\/api\/artifacts\/([^/]+)$/.exec(pathname)

        if (artifactDetailMatch && method === "GET") {
          const artifactId = decodeURIComponent(artifactDetailMatch[1] ?? "")
          const artifact = hubDb.getArtifact(artifactId)

          if (!artifact) return errorResponse(`Artifact not found: ${artifactId}`, 404)
          const versionParam = parsedUrl.searchParams.get("version")
          const requestedVersion = versionParam ? Number(versionParam) : undefined
          const variantParam = parsedUrl.searchParams.get("variant") ?? undefined
          const content = hubDb.readArtifactContent(artifact.id, requestedVersion, variantParam)
          const threads = hubDb.listCommentThreads(artifact.id)

          const { payload, targetSessionId } = hubDb.getCurrentReviewPayload(artifact.id)

          return jsonResponse({
            artifact,
            content,
            threads,
            agentPayloadPreview: payload,
            targetSessionId: targetSessionId ?? null,
          })
        }

        const artifactPreviewHtmlMatch = /^\/api\/artifacts\/([^/]+)\/preview$/.exec(pathname)

        if (artifactPreviewHtmlMatch && method === "GET") {
          const artifactId = decodeURIComponent(artifactPreviewHtmlMatch[1] ?? "")
          const artifact = hubDb.getArtifact(artifactId)

          if (!artifact) return errorResponse("Artifact not found", 404)

          const variantParam = parsedUrl.searchParams.get("variant") ?? artifact.metadata.selectedVariantId ?? undefined

          const versionParam = parsedUrl.searchParams.get("version")
          const requestedVersion = versionParam ? Number(versionParam) : undefined
          const html = hubDb.readArtifactContent(artifact.id, requestedVersion, variantParam)
          const bridgedHtml = injectHtmlPreviewBridge(html)

          return new Response(bridgedHtml, {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy": "sandbox allow-scripts",
            },
          })
        }

        const artifactContentMatch = /^\/api\/artifacts\/([^/]+)\/content$/.exec(pathname)

        if (artifactContentMatch && method === "PUT") {
          const artifactId = decodeURIComponent(artifactContentMatch[1] ?? "")
          const existing = hubDb.getArtifact(artifactId)

          if (!existing) return errorResponse("Artifact not found", 404)
          const body = SaveContentBodySchema.parse(await req.json())

          if (body.publishNewVersion) {
            const published = hubDb.putArtifact({
              projectId: existing.projectId,
              ...(existing.taskId !== undefined && { taskId: existing.taskId }),
              slug: existing.slug,
              title: existing.title,
              kind: existing.kind,
              summary: body.summary ?? `Updated v${existing.version + 1}`,
              content: body.content,
              reviewStatus: body.requestReview ? "requested" : existing.reviewStatus,
              questions: existing.questions,
              metadata: existing.metadata,
              ...(existing.authorSessionId !== undefined && { authorSessionId: existing.authorSessionId }),
            })

            return jsonResponse({ artifact: published })
          }

          const saved = hubDb.saveArtifactContentInPlace(existing.id, body.content)
          broadcastJson(
            JSON.stringify({
              kind: "hub.artifact_saved",
              artifactId: saved.id,
              at: Date.now(),
            }),
          )

          return jsonResponse({ artifact: saved, savedAt: Date.now() })
        }

        const generateWbMatch = /^\/api\/artifacts\/([^/]+)\/whiteboard-template$/.exec(pathname)

        if (generateWbMatch && method === "POST") {
          const artifactId = decodeURIComponent(generateWbMatch[1] ?? "")
          const existing = hubDb.getArtifact(artifactId)

          if (!existing) return errorResponse("Artifact not found", 404)
          const body = GenerateWhiteboardBodySchema.parse(await req.json())
          const preset: ArchitecturePreset = body.preset
          const sceneJson = generateArchitectureScene(preset)
          hubDb.saveArtifactContentInPlace(existing.id, sceneJson)
          broadcastJson(
            JSON.stringify({
              kind: "hub.artifact_saved",
              artifactId: existing.id,
              at: Date.now(),
            }),
          )

          return jsonResponse({ content: sceneJson })
        }

        const variantSelectMatch = /^\/api\/artifacts\/([^/]+)\/variant$/.exec(pathname)

        if (variantSelectMatch && method === "PATCH") {
          const artifactId = decodeURIComponent(variantSelectMatch[1] ?? "")
          const existing = hubDb.getArtifact(artifactId)

          if (!existing) return errorResponse("Artifact not found", 404)
          const body = SelectVariantBodySchema.parse(await req.json())

          const updated = hubDb.updateArtifactMetadata(existing.id, {
            ...existing.metadata,
            selectedVariantId: body.selectedVariantId,
          })

          return jsonResponse({ artifact: updated })
        }

        const answerQuestionMatch = /^\/api\/artifacts\/([^/]+)\/answers$/.exec(pathname)

        if (answerQuestionMatch && method === "POST") {
          const artifactId = decodeURIComponent(answerQuestionMatch[1] ?? "")
          const body = AnswerQuestionBodySchema.parse(await req.json())
          const updated = hubDb.answerQuestion(artifactId, body.questionId, body.selectedOptionIds)
          const { payload } = hubDb.getCurrentReviewPayload(updated.id)

          return jsonResponse({ artifact: updated, agentPayloadPreview: payload })
        }

        const commentsMatch = /^\/api\/artifacts\/([^/]+)\/comments$/.exec(pathname)

        if (commentsMatch && method === "POST") {
          const artifactId = decodeURIComponent(commentsMatch[1] ?? "")
          const body = CreateCommentBodySchema.parse(await req.json())

          const thread = hubDb.addCommentThread({
            artifactId,
            ...(body.author !== undefined && { author: body.author }),
            body: body.body,
            anchor: body.anchor,
          })

          const { payload } = hubDb.getCurrentReviewPayload(artifactId)

          return jsonResponse({ thread, agentPayloadPreview: payload }, 201)
        }

        const replyMatch = /^\/api\/comments\/([^/]+)\/replies$/.exec(pathname)

        if (replyMatch && method === "POST") {
          const threadId = decodeURIComponent(replyMatch[1] ?? "")
          const body = ReplyCommentBodySchema.parse(await req.json())
          const thread = hubDb.replyToCommentThread(threadId, body.body, body.author)

          return jsonResponse({ thread })
        }

        const resolveMatch = /^\/api\/comments\/([^/]+)\/resolve$/.exec(pathname)

        if (resolveMatch && method === "PATCH") {
          const threadId = decodeURIComponent(resolveMatch[1] ?? "")
          const body = ResolveCommentBodySchema.parse(await req.json())
          const thread = hubDb.setCommentResolved(threadId, body.resolved)

          return jsonResponse({ thread })
        }

        const reviewMatch = /^\/api\/artifacts\/([^/]+)\/review$/.exec(pathname)

        if (reviewMatch && method === "POST") {
          const artifactId = decodeURIComponent(reviewMatch[1] ?? "")
          const body = SubmitReviewBodySchema.parse(await req.json())

          const result = hubDb.submitReview({
            artifactId,
            verdict: body.verdict,
            ...(body.reviewerNote !== undefined && { reviewerNote: body.reviewerNote }),
            ...(body.answers !== undefined && { answers: body.answers }),
          })

          const targetId = body.overrideTargetSessionId ?? result.targetSessionId

          const delivery =
            body.deliverViaVibestSend && targetId
              ? tryDeliverVibestSend(targetId, result.agentPayload)
              : { attempted: false, delivered: false, detail: "Opt-in live delivery not enabled" }

          return jsonResponse({
            artifact: result.artifact,
            agentPayload: result.agentPayload,
            targetSessionId: targetId ?? null,
            delivery,
          })
        }

        if (pathname.startsWith("/excalidraw-assets/")) {
          const relAsset = pathname.slice("/excalidraw-assets/".length)
          const safeAsset = path.resolve(EXCALIDRAW_PROD_DIR, relAsset)

          if (safeAsset.startsWith(EXCALIDRAW_PROD_DIR + path.sep) && fs.existsSync(safeAsset)) {
            return new Response(Bun.file(safeAsset), {
              headers: { "content-type": contentTypeForPath(safeAsset) },
            })
          }

          return errorResponse("Asset not found", 404)
        }

        const requestedDistFile = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
        const candidateDistPath = path.resolve(distDir, requestedDistFile)

        if (
          candidateDistPath.startsWith(distDir + path.sep) &&
          fs.existsSync(candidateDistPath) &&
          fs.statSync(candidateDistPath).isFile()
        ) {
          return new Response(Bun.file(candidateDistPath), {
            headers: {
              "content-type": contentTypeForPath(candidateDistPath),
              "cache-control": "no-store",
            },
          })
        }

        const fallbackIndex = path.join(distDir, "index.html")

        if (fs.existsSync(fallbackIndex)) {
          return new Response(Bun.file(fallbackIndex), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            },
          })
        }

        return errorResponse("Not found", 404)
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unexpected server error"

        return errorResponse(message, 400)
      }
    },
    websocket: {
      open(ws) {
        wsClients.add(ws)
        ws.send(JSON.stringify({ kind: "hub.connected", at: Date.now() }))
      },
      message() {
        return
      },
      close(ws) {
        wsClients.delete(ws)
      },
    },
  })

  const boundUrl = `http://${hostname}:${server.port}`

  return {
    server,
    hubDb,
    url: boundUrl,
    stop() {
      unsubscribeDb()
      server.stop(true)
      hubDb.close()
    },
  }
}

if (import.meta.main) {
  createHubServer()
    .then((running) => {
      console.log(`Vibest Project & Artifact Hub listening on ${running.url}`)
    })
    .catch((err: Error) => {
      console.error(err.message)
      process.exit(1)
    })
}
