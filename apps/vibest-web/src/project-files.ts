import fs from "node:fs"
import path from "node:path"

import type { KnowledgeCategory, ProjectFileEntry } from "./types.ts"

const CATEGORIES: ReadonlyArray<Exclude<KnowledgeCategory, "preferences">> = ["artifacts", "docs", "memories"]
const VALID_PROJECT_ID = /^[a-zA-Z0-9._-]+$/

export function isValidProjectId(projectId: string): boolean {
  if (projectId.length === 0 || projectId === "." || projectId === "..") return false

  return VALID_PROJECT_ID.test(projectId)
}

function realPathOrAncestor(targetPath: string): string | null {
  let current = targetPath

  while (true) {
    if (fs.existsSync(current)) {
      try {
        const realBase = fs.realpathSync(current)
        const suffix = path.relative(current, targetPath)

        return suffix.length === 0 ? realBase : path.join(realBase, suffix)
      } catch {
        return null
      }
    }

    const parent = path.dirname(current)

    if (parent === current) return null
    current = parent
  }
}

export function resolveSafeProjectDir(vibestHome: string, projectId: string): string | null {
  if (!isValidProjectId(projectId)) return null

  const projectsRoot = path.resolve(vibestHome, "projects")
  const projectDir = path.resolve(projectsRoot, projectId)

  if (!projectDir.startsWith(`${projectsRoot}${path.sep}`)) return null

  if (fs.existsSync(projectsRoot) && fs.existsSync(projectDir)) {
    try {
      const realRoot = fs.realpathSync(projectsRoot)
      const realDir = fs.realpathSync(projectDir)

      if (!realDir.startsWith(`${realRoot}${path.sep}`)) return null

      return realDir
    } catch {
      return null
    }
  }

  return projectDir
}

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
  realProjectDir: string,
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

    if (entry.isSymbolicLink()) continue

    if (entry.isDirectory()) {
      walkCategoryFiles(projectId, realProjectDir, category, absPath, out)
      continue
    }

    if (!entry.isFile()) continue

    try {
      const realFile = fs.realpathSync(absPath)

      if (!realFile.startsWith(`${realProjectDir}${path.sep}`)) continue
      const stat = fs.statSync(realFile)
      const relativePath = path.relative(realProjectDir, realFile).replaceAll("\\", "/")
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
  const projectDir = resolveSafeProjectDir(vibestHome, projectId)

  if (projectDir === null || !fs.existsSync(projectDir)) return []

  const results: ProjectFileEntry[] = []

  const prefPath = path.join(projectDir, "preferences.md")

  if (fs.existsSync(prefPath)) {
    try {
      const lstat = fs.lstatSync(prefPath)

      if (!lstat.isSymbolicLink() && lstat.isFile()) {
        results.push({
          id: `${projectId}:preferences.md`,
          projectId,
          category: "preferences",
          name: "preferences.md",
          relativePath: "preferences.md",
          extension: ".md",
          size: lstat.size,
          updatedAt: Math.round(lstat.mtimeMs),
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
  const projectDir = resolveSafeProjectDir(vibestHome, projectId)

  if (projectDir === null) return null

  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"))

  if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) return null

  const allowedRoot =
    normalized === "preferences.md" ||
    normalized.startsWith("artifacts/") ||
    normalized.startsWith("docs/") ||
    normalized.startsWith("memories/")

  if (!allowedRoot) return null

  const resolved = path.resolve(projectDir, normalized)

  if (!resolved.startsWith(`${projectDir}${path.sep}`)) return null

  const realProjectDir = realPathOrAncestor(projectDir)

  if (realProjectDir === null) return null

  const realTarget = realPathOrAncestor(resolved)

  if (realTarget === null) return null

  if (!realTarget.startsWith(`${realProjectDir}${path.sep}`)) return null

  return realTarget
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
    const projectDir = resolveSafeProjectDir(vibestHome, projectId)

    if (projectDir === null || !fs.existsSync(projectDir)) continue

    try {
      const watcher = fs.watch(projectDir, { recursive: true }, () => {
        onChanged(projectId)
      })

      watcher.on("error", () => {})
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
