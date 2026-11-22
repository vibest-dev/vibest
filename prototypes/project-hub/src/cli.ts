import fs from "node:fs"
import path from "node:path"
import url from "node:url"

import { previewVerdictForStatus } from "./database-rows.ts"
import { HubDatabase } from "./database.ts"
import { ArtifactKindSchema, TaskStatusSchema, type ArtifactKind } from "./schema.ts"
import { seedDefaultDemoProject } from "./seed.ts"
import { importVibestProjectReadOnly } from "./vibest-import.ts"

const MODULE_DIR = path.dirname(url.fileURLToPath(import.meta.url))
const DEFAULT_DATA_DIR = path.resolve(MODULE_DIR, "..", ".data")

interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string[]>
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  let idx = 0

  while (idx < argv.length) {
    const token = argv[idx]

    if (token === undefined) break

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=")

      if (eqIdx !== -1) {
        const key = token.slice(2, eqIdx)
        const val = token.slice(eqIdx + 1)
        flags.set(key, [...(flags.get(key) ?? []), val])
        idx += 1
      } else {
        const key = token.slice(2)
        const next = argv[idx + 1]

        if (next !== undefined && !next.startsWith("--")) {
          flags.set(key, [...(flags.get(key) ?? []), next])
          idx += 2
        } else {
          flags.set(key, [...(flags.get(key) ?? []), "true"])
          idx += 1
        }
      }
    } else {
      positionals.push(token)
      idx += 1
    }
  }

  return { positionals, flags }
}

function getFlag(flags: Map<string, string[]>, key: string): string | undefined {
  const list = flags.get(key)

  return list ? list[list.length - 1] : undefined
}

function hasFlag(flags: Map<string, string[]>, key: string): boolean {
  return flags.has(key)
}

async function notifyLiveServerIfRunning(serverUrl: string): Promise<void> {
  try {
    await fetch(`${serverUrl}/api/notify-reload`, {
      method: "POST",
      signal: AbortSignal.timeout(400),
    })
  } catch {
    return
  }
}

function printUsage(): void {
  const help = [
    "Vibest Project & Artifact Hub — Companion Agent CLI",
    "",
    "Usage:",
    "  bun prototypes/project-hub/src/cli.ts <command> [subcommand] [options]",
    "",
    "Commands:",
    "  project ls",
    "  project add --name <name> [--description <text>] [--import-vibest-dir <dir>]",
    "  board [--project <id-or-slug>]",
    "  task ls [--project <id-or-slug>]",
    "  task create --title <title> [--summary <text>] [--branch <branch>] [--pr <url>] [--project <id>]",
    "  task update <taskId> [--summary <text>] [--status active|done|cancelled] [--branch <branch>] [--pr <url>]",
    "  task done <taskId> [--summary <text>]",
    "  artifact ls [--project <id-or-slug>]",
    "  artifact put <markdown|html|whiteboard|verify> <file> [--title <title>] [--slug <slug>] [--task <taskId>] [--summary <text>] [--variant <id>:<label>:<file>] [--request-review] [--project <id>]",
    "  artifact comments <artifactId-or-slug>",
    "",
    "Global Options:",
    "  --data-dir <dir>   Override prototype SQLite/files data directory",
    "  --server <url>     Notify running Hub server for WebSocket broadcast (default http://127.0.0.1:4310)",
    "  --json             Print machine-readable JSON output",
  ].join("\n")

  console.log(help)
}

export async function runCli(argv: string[]): Promise<number> {
  const { positionals, flags } = parseCliArgs(argv)
  const cmd = positionals[0]

  if (!cmd || cmd === "help" || hasFlag(flags, "help")) {
    printUsage()

    return 0
  }

  const dataDir = path.resolve(getFlag(flags, "data-dir") ?? process.env.HUB_DATA_DIR ?? DEFAULT_DATA_DIR)
  const serverUrl = getFlag(flags, "server") ?? process.env.HUB_SERVER_URL ?? "http://127.0.0.1:4310"
  const asJson = hasFlag(flags, "json")

  const hubDb = new HubDatabase(dataDir)

  try {
    seedDefaultDemoProject(hubDb)

    const resolveTargetProject = () => {
      const requested = getFlag(flags, "project")

      if (requested) {
        const found = hubDb.getProject(requested)

        if (!found) throw new Error(`Project not found: ${requested}`)

        return found
      }

      const all = hubDb.listProjects()

      if (all[0] === undefined) throw new Error("No projects registered")

      return all[0]
    }

    if (cmd === "project") {
      const sub = positionals[1] ?? "ls"

      if (sub === "ls") {
        const projects = hubDb.listProjects()

        if (asJson) {
          console.log(JSON.stringify(projects, null, 2))
        } else {
          for (const p of projects) {
            const board = hubDb.getBoard(p.id)
            console.log(
              `${p.id}  ${p.slug.padEnd(20)}  NeedsYou=${board.needsYou.length}  InProgress=${board.inProgress.length}  ${p.description}`,
            )
          }
        }

        return 0
      }

      if (sub === "add") {
        const importDir = getFlag(flags, "import-vibest-dir")
        const name = getFlag(flags, "name")

        if (importDir) {
          const result = importVibestProjectReadOnly(hubDb, {
            ...(name !== undefined && { name }),
            vibestProjectDir: importDir,
          })

          await notifyLiveServerIfRunning(serverUrl)

          if (asJson) {
            console.log(JSON.stringify(result, null, 2))
          } else {
            console.log(
              `Imported project ${result.project.id} (${result.project.name}): ${result.copiedKnowledgeFiles} knowledge files, ${result.importedSessions} sessions.`,
            )
          }

          return 0
        }

        if (!name) throw new Error("Missing --name <name> for project add")

        const created = hubDb.createProject({
          name,
          description: getFlag(flags, "description") ?? "Managed in Vibest Project Hub",
          ...(getFlag(flags, "repo") !== undefined && { repoPath: getFlag(flags, "repo") }),
        })

        await notifyLiveServerIfRunning(serverUrl)
        console.log(asJson ? JSON.stringify(created, null, 2) : `Created project ${created.id} (${created.name})`)

        return 0
      }

      throw new Error(`Unknown project subcommand: ${sub}`)
    }

    if (cmd === "board") {
      const project = resolveTargetProject()
      const board = hubDb.getBoard(project.id)

      if (asJson) {
        console.log(JSON.stringify(board, null, 2))

        return 0
      }

      const lines: string[] = [
        `=== Board: ${board.project.name} (${board.project.id}) ===`,
        "",
        `[NEEDS YOU: ${board.needsYou.length}]`,
      ]

      if (board.needsYou.length === 0) {
        lines.push("  (all clear)")
      }

      for (const item of board.needsYou) {
        if (item.itemType === "artifact_review") {
          lines.push(
            `  • ARTIFACT ${item.artifact.id} (${item.artifact.kind} v${item.artifact.version}) "${item.artifact.title}" — ${item.openCommentCount} open comments, ${item.unansweredQuestionCount} unanswered questions`,
          )
        } else {
          lines.push(
            `  • BLOCKED SESSION ${item.session.id} (${item.session.name}) — ${item.session.blockedReason ?? "blocked"}`,
          )
        }
      }

      lines.push("", `[IN PROGRESS: ${board.inProgress.length}]`)

      for (const lane of board.inProgress) {
        lines.push(
          `  • ${lane.task.id}  ${lane.task.title}${lane.task.branch ? ` [${lane.task.branch}]` : ""} — ${lane.task.summary}`,
        )
      }

      lines.push(
        "",
        `[DONE: ${board.doneTasks.length} tasks, ${board.doneStandaloneArtifacts.length} standalone artifacts]`,
      )

      for (const lane of board.doneTasks) {
        lines.push(`  • ${lane.task.id}  ${lane.task.title} — ${lane.task.summary}`)
      }

      lines.push("", "--- Compaction-Proof Session Facts ---", board.sessionFactsMarkdown)
      console.log(lines.join("\n"))

      return 0
    }

    if (cmd === "task") {
      const sub = positionals[1] ?? "ls"
      const project = resolveTargetProject()

      if (sub === "ls") {
        const tasks = hubDb.listTasks(project.id)

        if (asJson) {
          console.log(JSON.stringify(tasks, null, 2))
        } else {
          for (const t of tasks) {
            console.log(`${t.id}  [${t.status.padEnd(9)}]  ${t.title} — ${t.summary}`)
          }
        }

        return 0
      }

      if (sub === "create") {
        const title = getFlag(flags, "title") ?? positionals[2]

        if (!title) throw new Error("Missing --title <title> for task create")

        const created = hubDb.createTask({
          projectId: project.id,
          title,
          summary: getFlag(flags, "summary") ?? "Workstream started",
          ...(getFlag(flags, "branch") !== undefined && { branch: getFlag(flags, "branch") }),
          ...(getFlag(flags, "pr") !== undefined && { prUrl: getFlag(flags, "pr") }),
        })

        await notifyLiveServerIfRunning(serverUrl)
        console.log(asJson ? JSON.stringify(created, null, 2) : `Created task ${created.id}: ${created.title}`)

        return 0
      }

      if (sub === "update" || sub === "done") {
        const taskId = positionals[2]

        if (!taskId) throw new Error(`Missing <taskId> for task ${sub}`)
        const statusRaw = sub === "done" ? "done" : getFlag(flags, "status")
        const parsedStatus = statusRaw ? TaskStatusSchema.parse(statusRaw) : undefined
        const summary = getFlag(flags, "summary")
        const branch = getFlag(flags, "branch")
        const prUrl = getFlag(flags, "pr")

        const updated = hubDb.updateTask(taskId, {
          ...(getFlag(flags, "title") !== undefined && { title: getFlag(flags, "title") }),
          ...(parsedStatus !== undefined && { status: parsedStatus }),
          ...(summary !== undefined && { summary }),
          ...(branch !== undefined && { branch }),
          ...(prUrl !== undefined && { prUrl }),
        })

        await notifyLiveServerIfRunning(serverUrl)
        console.log(
          asJson
            ? JSON.stringify(updated, null, 2)
            : `Updated task ${updated.id} -> [${updated.status}] ${updated.summary}`,
        )

        return 0
      }

      throw new Error(`Unknown task subcommand: ${sub}`)
    }

    if (cmd === "artifact") {
      const sub = positionals[1] ?? "ls"
      const project = resolveTargetProject()

      if (sub === "ls") {
        const artifacts = hubDb.listArtifacts(project.id)

        if (asJson) {
          console.log(JSON.stringify(artifacts, null, 2))
        } else {
          for (const a of artifacts) {
            console.log(
              `${a.id}  v${a.version}  [${a.kind.padEnd(10)}]  review=${a.reviewStatus.padEnd(17)}  ${a.slug} — ${a.title}`,
            )
          }
        }

        return 0
      }

      if (sub === "put") {
        const kindRaw = positionals[2]
        const filePathArg = positionals[3]

        if (!kindRaw || !filePathArg) {
          throw new Error(
            "Usage: artifact put <markdown|html|whiteboard|verify> <file> [--title ...] [--request-review]",
          )
        }

        const kind: ArtifactKind = ArtifactKindSchema.parse(kindRaw)
        const absFile = path.resolve(filePathArg)

        if (!fs.existsSync(absFile)) throw new Error(`Artifact file not found: ${absFile}`)
        const content = fs.readFileSync(absFile, "utf8")
        const title = getFlag(flags, "title") ?? path.basename(absFile, path.extname(absFile))
        const slug = getFlag(flags, "slug")
        const taskId = getFlag(flags, "task")
        const summary = getFlag(flags, "summary") ?? `Published ${path.basename(absFile)}`
        const requestReview = hasFlag(flags, "request-review")
        const authorSessionId = getFlag(flags, "author-session")

        const variantSpecs = flags.get("variant") ?? []
        const extraFiles: Array<{ fileName: string; content: string }> = []

        const variants = variantSpecs.map((spec, index) => {
          const parts = spec.split(":")
          const id = parts[0] ?? `variant-${index + 1}`
          const label = parts.length >= 3 ? (parts[1] ?? id) : id
          const variantPath = path.resolve(parts.length >= 3 ? parts.slice(2).join(":") : (parts[1] ?? absFile))
          const fileName = `${id}${path.extname(variantPath) || ".html"}`
          extraFiles.push({
            fileName,
            content: fs.readFileSync(variantPath, "utf8"),
          })

          return { id, label, fileName }
        })

        const saved = hubDb.putArtifact({
          projectId: project.id,
          ...(taskId !== undefined && { taskId }),
          ...(slug !== undefined && { slug }),
          title,
          kind,
          summary,
          content,
          reviewStatus: requestReview ? "requested" : "none",
          ...(authorSessionId !== undefined && { authorSessionId }),
          ...(extraFiles.length > 0 && { extraFiles }),
          ...(variants.length > 0 && {
            metadata: {
              selectedVariantId: variants[0]?.id,
              variants,
            },
          }),
        })

        await notifyLiveServerIfRunning(serverUrl)
        console.log(
          asJson
            ? JSON.stringify(saved, null, 2)
            : `Published artifact ${saved.id} (${saved.slug}) v${saved.version} [review=${saved.reviewStatus}]`,
        )

        return 0
      }

      if (sub === "comments") {
        const artifactRef = positionals[2]

        if (!artifactRef) throw new Error("Usage: artifact comments <artifactId-or-slug>")
        const artifact = hubDb.getArtifact(artifactRef)

        if (!artifact) throw new Error(`Artifact not found: ${artifactRef}`)
        const threads = hubDb.listCommentThreads(artifact.id)

        const verdictForPreview = previewVerdictForStatus(artifact.reviewStatus)

        const { payload } = hubDb.buildAgentReviewPayload(artifact.id, verdictForPreview)

        if (asJson) {
          console.log(
            JSON.stringify(
              {
                artifactId: artifact.id,
                slug: artifact.slug,
                version: artifact.version,
                reviewStatus: artifact.reviewStatus,
                answers: artifact.answers,
                threads,
                agentPayload: artifact.lastReviewPayload ?? payload,
              },
              null,
              2,
            ),
          )
        } else {
          console.log(artifact.lastReviewPayload ?? payload)
        }

        return 0
      }

      throw new Error(`Unknown artifact subcommand: ${sub}`)
    }

    throw new Error(`Unknown command: ${cmd}`)
  } finally {
    hubDb.close()
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code)
    })
    .catch((err: Error) => {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    })
}
