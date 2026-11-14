import { Effect, FileSystem, Option, Path, PlatformError, Schema } from "effect"

import { Git } from "./git.ts"

const gitDirectory = (p: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(p).pipe(
      Effect.catchIf(
        (e) => e.reason._tag === "NotFound",
        () => Effect.succeed(undefined),
      ),
    )
    if (info === undefined || info.type !== "Directory") return undefined
    return p
  })

export const mainCheckout = (dir: string) => Git.Service.use((git) => git.mainCheckout(dir))

const remoteRepositoryName = (url: string) => {
  const bare = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
  const cut = Math.max(bare.lastIndexOf("/"), bare.lastIndexOf(":"))
  return cut === -1 ? bare : bare.slice(cut + 1)
}

export const repositoryDirectoryName = Effect.fn("repositoryDirectoryName")(function* (dir: string) {
  const main = yield* mainCheckout(dir)
  const remote = yield* Git.Service.use((git) => git.originUrl(main))
  return remote ? remoteRepositoryName(remote) : (yield* Path.Path).basename(main)
})

export const allocationParentBlocked = Effect.fn("allocationParentBlocked")(function* (dir: string) {
  if (!(yield* entryTaken(dir))) return false
  if ((yield* gitDirectory(dir)) === undefined) return true
  const fs = yield* FileSystem.FileSystem
  return yield* fs.exists((yield* Path.Path).join(dir, ".git"))
})

export const addWorktree = (root: string, path: string, commit?: string) =>
  Git.Service.use((git) => git.addWorktree(root, path, commit))

export const removeWorktree = (root: string, path: string) => Git.Service.use((git) => git.removeWorktree(root, path))

export class CopyFailed extends Schema.TaggedError<CopyFailed>()("CopyFailed", {
  source: Schema.String,
  destination: Schema.String,
  message: Schema.String,
}) {}

const linkTarget = (p: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readLink(p).pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        (e) => e.reason._tag === "NotFound" || (e.reason.cause as { code?: unknown } | undefined)?.code === "EINVAL",
        () => Effect.succeed(Option.none<string>()),
      ),
    )
  })

export const entryTaken = (p: string) =>
  Effect.gen(function* () {
    if (Option.isSome(yield* linkTarget(p))) return true
    return yield* (yield* FileSystem.FileSystem).exists(p)
  })

const linkOnPath = (base: string, rel: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    let at = base
    for (const part of rel.split("/").slice(0, -1)) {
      at = path.join(at, part)
      if (Option.isSome(yield* linkTarget(at))) return true
    }
    return false
  })

const copyFailed = (src: string, dst: string) => (e: PlatformError.PlatformError) => {
  const code = (e.reason.cause as { code?: unknown } | undefined)?.code
  return new CopyFailed({
    source: src,
    destination: dst,
    message: `copy ${src} -> ${dst}: ${e.message}${typeof code === "string" ? ` (${code})` : ""}`,
  })
}

export const copyIncluded = Effect.fn("copyIncluded")(function* (root: string, worktree: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const open: string[] = []
  const git = yield* Git.Service
  for (const f of yield* git.includedFiles(root)) {
    const dst = path.join(worktree, f)
    const taken = yield* Effect.gen(function* () {
      return (yield* linkOnPath(worktree, f)) || (yield* fs.exists(dst)) || Option.isSome(yield* linkTarget(dst))
    }).pipe(Effect.mapError(copyFailed(path.join(root, f), dst)))
    if (!taken) open.push(f)
  }
  const ignored = new Set(yield* git.ignored(worktree, open))
  const copied: string[] = []
  for (const f of open.filter((f) => ignored.has(f))) {
    const src = path.join(root, f)
    const dst = path.join(worktree, f)
    const done = yield* Effect.gen(function* () {
      const link = yield* linkTarget(src)
      if (Option.isNone(link) && (yield* fs.stat(src)).type !== "File") return false
      yield* fs.makeDirectory(path.dirname(dst), { recursive: true })
      yield* Option.isSome(link) ? fs.symlink(link.value, dst) : fs.copyFile(src, dst)
      return true
    }).pipe(Effect.mapError(copyFailed(src, dst)))
    if (done) copied.push(f)
  }
  return copied
})

export const gitState = (worktree: string) => Git.Service.use((git) => git.state(worktree))
