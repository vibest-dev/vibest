import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { z } from "zod"

import type { HubDatabase } from "./database.ts"
import type { Project, SessionStatus } from "./schema.ts"

const ExternalProjectRowSchema = z.object({
  id: z.string(),
  directory: z.string().nullable(),
  entry_session_id: z.string().nullable(),
})

const ExternalSessionRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  parent_session_id: z.string().nullable(),
  agent: z.string(),
  name: z.string(),
  directory: z.string(),
  ended_at: z.number().nullable(),
  harness: z.string().nullable(),
  model: z.string().nullable(),
  process_ended_at: z.number().nullable(),
})

function externalSessionStatus(row: z.infer<typeof ExternalSessionRowSchema>): SessionStatus {
  if (row.ended_at !== null) return "ended"

  if (row.harness !== null && row.process_ended_at === null) return "running"

  return "idle"
}

export interface VibestImportResult {
  project: Project
  copiedKnowledgeFiles: number
  importedSessions: number
}

function copyMarkdownTreeReadOnly(
  hubDb: HubDatabase,
  projectId: string,
  sourceRoot: string,
  subPath: "memories" | "docs",
): number {
  const absSource = path.join(sourceRoot, subPath)

  if (!fs.existsSync(absSource) || !fs.statSync(absSource).isDirectory()) return 0
  let count = 0

  const walk = (relFromSub: string) => {
    const dir = path.join(absSource, relFromSub)

    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(".")) continue
      const nextRel = relFromSub ? path.posix.join(relFromSub, entry) : entry
      const fullPath = path.join(absSource, nextRel)
      const stat = fs.statSync(fullPath)

      if (stat.isDirectory()) {
        walk(nextRel)
      } else if (entry.endsWith(".md") && stat.size <= 512_000) {
        const content = fs.readFileSync(fullPath, "utf8")
        hubDb.writeKnowledgeFile(projectId, path.posix.join(subPath, nextRel), content)
        count += 1
      }
    }
  }

  walk("")

  return count
}

export function defaultVibestDbPath(): string {
  return path.join(os.homedir(), ".vibest", "vibest.db")
}

export function importVibestProjectReadOnly(
  hubDb: HubDatabase,
  input: {
    name?: string
    vibestProjectDir: string
    vibestDbPath?: string
  },
): VibestImportResult {
  const resolvedProjectDir = path.resolve(input.vibestProjectDir)

  if (!fs.existsSync(resolvedProjectDir) || !fs.statSync(resolvedProjectDir).isDirectory()) {
    throw new Error(`Vibest project directory does not exist: ${resolvedProjectDir}`)
  }

  const folderId = path.basename(resolvedProjectDir)
  const inferredName = input.name && input.name.trim().length > 0 ? input.name.trim() : `vibest-${folderId.slice(0, 8)}`

  let entrySessionId: string | undefined
  let repoDirectory: string | undefined
  let externalSessions: z.infer<typeof ExternalSessionRowSchema>[] = []

  const candidateDbPath = input.vibestDbPath ?? defaultVibestDbPath()

  if (fs.existsSync(candidateDbPath) && fs.statSync(candidateDbPath).isFile()) {
    const extDb = new Database(candidateDbPath, { readonly: true })
    extDb.exec("PRAGMA query_only = ON")

    try {
      const projectRowRaw = extDb
        .query("SELECT id, directory, entry_session_id FROM project WHERE id = ?")
        .get(folderId)

      if (projectRowRaw !== null) {
        const parsedProj = ExternalProjectRowSchema.parse(projectRowRaw)
        entrySessionId = parsedProj.entry_session_id ?? undefined
        repoDirectory = parsedProj.directory ?? undefined

        const sessionRowsRaw = extDb
          .query(
            `SELECT
               s.id,
               s.project_id,
               s.parent_session_id,
               s.agent,
               s.name,
               s.directory,
               s.ended_at,
               p.harness AS harness,
               p.model AS model,
               p.ended_at AS process_ended_at
             FROM session s
             LEFT JOIN process p ON p.session_id = s.id AND p.id = s.process_id
             WHERE s.project_id = ?
             ORDER BY s.created_at DESC
             LIMIT 40`,
          )
          .all(folderId)

        externalSessions = z.array(ExternalSessionRowSchema).parse(sessionRowsRaw)
      }
    } catch {
      externalSessions = []
    } finally {
      extDb.close()
    }
  }

  const project = hubDb.createProject({
    name: inferredName,
    description: `Read-only snapshot imported from ${resolvedProjectDir}`,
    ...(repoDirectory !== undefined && { repoPath: repoDirectory }),
    vibestProjectDir: resolvedProjectDir,
    ...(entrySessionId !== undefined && { entrySessionId }),
  })

  let copiedKnowledgeFiles = 0
  const prefFile = path.join(resolvedProjectDir, "preferences.md")

  if (fs.existsSync(prefFile) && fs.statSync(prefFile).isFile()) {
    hubDb.writeKnowledgeFile(project.id, "preferences.md", fs.readFileSync(prefFile, "utf8"))
    copiedKnowledgeFiles += 1
  }

  copiedKnowledgeFiles += copyMarkdownTreeReadOnly(hubDb, project.id, resolvedProjectDir, "memories")
  copiedKnowledgeFiles += copyMarkdownTreeReadOnly(hubDb, project.id, resolvedProjectDir, "docs")

  const syncTask = hubDb.createTask({
    projectId: project.id,
    title: "Imported Vibest Live Sessions",
    status: "active",
    summary: `Synced ${externalSessions.length} session(s) and ${copiedKnowledgeFiles} knowledge file(s) in read-only mode.`,
    sessionIds: externalSessions.slice(0, 12).map((s) => `${project.id}-${s.id.slice(0, 8)}`),
  })

  let importedSessions = 0

  for (const row of externalSessions) {
    const status = externalSessionStatus(row)

    hubDb.upsertSession({
      id: `${project.id}-${row.id.slice(0, 8)}`,
      projectId: project.id,
      taskId: syncTask.id,
      ...(row.parent_session_id !== null && {
        parentSessionId: `${project.id}-${row.parent_session_id.slice(0, 8)}`,
      }),
      name: row.name || row.id.slice(0, 8),
      agent: row.agent,
      harness: row.harness ?? "claude",
      ...(row.model !== null && { model: row.model }),
      directory: row.directory,
      status,
    })
    importedSessions += 1
  }

  const artifactsFolder = path.join(resolvedProjectDir, "artifacts")

  if (fs.existsSync(artifactsFolder) && fs.statSync(artifactsFolder).isDirectory()) {
    const mdFiles = fs
      .readdirSync(artifactsFolder)
      .flatMap((name) => (name.endsWith(".md") ? [name] : []))
      .slice(0, 5)

    for (const fileName of mdFiles) {
      const fullPath = path.join(artifactsFolder, fileName)

      if (!fs.statSync(fullPath).isFile()) continue
      const content = fs.readFileSync(fullPath, "utf8")
      hubDb.putArtifact({
        projectId: project.id,
        taskId: syncTask.id,
        title: fileName.replace(/\.md$/, ""),
        kind: "markdown",
        summary: `Imported markdown artifact from ${fileName}`,
        content,
        reviewStatus: "none",
      })
    }
  }

  return {
    project,
    copiedKnowledgeFiles,
    importedSessions,
  }
}
