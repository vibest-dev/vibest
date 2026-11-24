import fs from "node:fs"
import path from "node:path"

import type { KnowledgeCategory, ProjectFileEntry } from "./types.ts"

const CATEGORIES: ReadonlyArray<Exclude<KnowledgeCategory, "preferences">> = ["artifacts", "docs", "memories"]

function detectFileKind(fileName: string): ProjectFileEntry["kind"] {
  const lower = fileName.toLowerCase()

  if (lower.endsWith(".excalidraw") || lower.endsWith(".excalidraw.json")) return "excalidraw"

  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html"

  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown"

  if (
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".svg")
  )
    return "image"

  if (lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov")) return "video"

  return "text"
}

function extensionOf(fileName: string): string {
  const lower = fileName.toLowerCase()

  if (lower.endsWith(".excalidraw.json")) return ".excalidraw"

  return path.extname(fileName).toLowerCase() || ".txt"
}

function walkCategoryFiles(
  projectId: string,
  projectDir: string,
  category: Exclude<KnowledgeCategory, "preferences">,
  currentDir: string,
  out: ProjectFileEntry[],
): void {
  if (!fs.existsSync(currentDir)) return

  let entries: fs.Dirent[]

  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const absPath = path.join(currentDir, entry.name)

    if (entry.isDirectory()) {
      walkCategoryFiles(projectId, projectDir, category, absPath, out)
      continue
    }

    if (!entry.isFile()) continue

    try {
      const stat = fs.statSync(absPath)
      const relativePath = path.relative(projectDir, absPath).replaceAll("\\", "/")
      out.push({
        id: `${projectId}:${relativePath}`,
        projectId,
        category,
        name: entry.name,
        relativePath,
        extension: extensionOf(entry.name),
        size: stat.size,
        updatedAt: Math.round(stat.mtimeMs),
        kind: detectFileKind(entry.name),
      })
    } catch {
      continue
    }
  }
}

export function scanProjectFiles(vibestHome: string, projectId: string): ReadonlyArray<ProjectFileEntry> {
  const projectDir = path.join(vibestHome, "projects", projectId)

  if (!fs.existsSync(projectDir)) return []

  const results: ProjectFileEntry[] = []

  const prefPath = path.join(projectDir, "preferences.md")

  if (fs.existsSync(prefPath)) {
    try {
      const stat = fs.statSync(prefPath)

      if (stat.isFile()) {
        results.push({
          id: `${projectId}:preferences.md`,
          projectId,
          category: "preferences",
          name: "preferences.md",
          relativePath: "preferences.md",
          extension: ".md",
          size: stat.size,
          updatedAt: Math.round(stat.mtimeMs),
          kind: "markdown",
        })
      }
    } catch {
      return results
    }
  }

  for (const category of CATEGORIES) {
    walkCategoryFiles(projectId, projectDir, category, path.join(projectDir, category), results)
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt || a.relativePath.localeCompare(b.relativePath))

  return results
}

export function resolveSafeProjectFilePath(vibestHome: string, projectId: string, relativePath: string): string | null {
  if (relativePath.length === 0 || relativePath.includes("\0")) return null
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"))

  if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) return null

  const allowedRoot =
    normalized === "preferences.md" ||
    normalized.startsWith("artifacts/") ||
    normalized.startsWith("docs/") ||
    normalized.startsWith("memories/")

  if (!allowedRoot) return null

  const projectDir = path.resolve(vibestHome, "projects", projectId)
  const resolved = path.resolve(projectDir, normalized)

  if (!resolved.startsWith(`${projectDir}${path.sep}`)) return null

  return resolved
}

export function readProjectTextFile(vibestHome: string, projectId: string, relativePath: string): string | null {
  const target = resolveSafeProjectFilePath(vibestHome, projectId, relativePath)

  if (target === null || !fs.existsSync(target)) return null

  return fs.readFileSync(target, "utf8")
}

export function writeProjectTextFile(
  vibestHome: string,
  projectId: string,
  relativePath: string,
  content: string,
): boolean {
  const target = resolveSafeProjectFilePath(vibestHome, projectId, relativePath)

  if (target === null) return false

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, "utf8")

  return true
}

export function watchProjectDirectories(
  vibestHome: string,
  projectIds: ReadonlyArray<string>,
  onChanged: (projectId: string) => void,
): () => void {
  const watchers: fs.FSWatcher[] = []

  for (const projectId of projectIds) {
    const projectDir = path.join(vibestHome, "projects", projectId)

    if (!fs.existsSync(projectDir)) continue

    try {
      const watcher = fs.watch(projectDir, { recursive: true }, () => {
        onChanged(projectId)
      })

      watchers.push(watcher)
    } catch {
      continue
    }
  }

  return () => {
    for (const watcher of watchers) {
      watcher.close()
    }
  }
}
