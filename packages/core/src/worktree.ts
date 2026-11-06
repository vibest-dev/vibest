import { NotInRepository } from "@vibest/schema/session"
import { Effect, FileSystem, Option, Path, PlatformError, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
export { NotInRepository } from "@vibest/schema/session"

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  args: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

const gitRaw = (cwd: string, args: ReadonlyArray<string>, input?: string, ok: ReadonlyArray<number> = [0]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const stdin = input === undefined ? {} : { stdin: Stream.make(new TextEncoder().encode(input)) }
    const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, ...stdin }))
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    )
    if (!ok.includes(exitCode)) return yield* new GitError({ args, message: stderr.trim() || `exit ${exitCode}` })
    return stdout
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (e) => Effect.fail(new GitError({ args, message: e.message }))),
  )

export const git = Effect.fn("git")(function* (cwd: string, ...args: string[]) {
  return (yield* gitRaw(cwd, args)).trim()
})

const tryGit = (cwd: string, ...args: string[]) => git(cwd, ...args).pipe(Effect.orElseSucceed(() => undefined))

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

export const mainCheckout = Effect.fn("mainCheckout")(function* (dir: string) {
  const cwd = yield* gitDirectory(dir).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)))
  if (cwd === undefined) return yield* new NotInRepository({ path: dir })
  const out = yield* git(
    dir,
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ).pipe(Effect.mapError(() => new NotInRepository({ path: dir })))
  const [top = "", gitDir, common = ""] = out.split("\n")
  return gitDir === common ? top : (yield* Path.Path).dirname(common)
})

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
  const remote = yield* tryGit(main, "config", "--get", "remote.origin.url")
  return remote ? remoteRepositoryName(remote) : (yield* Path.Path).basename(main)
})

export const allocationParentBlocked = Effect.fn("allocationParentBlocked")(function* (dir: string) {
  if (!(yield* entryTaken(dir))) return false
  if ((yield* gitDirectory(dir)) === undefined) return true
  const fs = yield* FileSystem.FileSystem
  return yield* fs.exists((yield* Path.Path).join(dir, ".git"))
})

export const addWorktree = Effect.fn("addWorktree")(function* (root: string, path: string) {
  yield* git(root, "worktree", "add", "--detach", path)
})

export class CopyFailed extends Schema.TaggedError<CopyFailed>()("CopyFailed", {
  source: Schema.String,
  destination: Schema.String,
  message: Schema.String,
}) {}

const nul = (out: string) => out.split("\0").filter(Boolean)

const ignoredIn = (cwd: string, paths: ReadonlyArray<string>) =>
  paths.length === 0
    ? Effect.succeed([])
    : gitRaw(cwd, ["check-ignore", "-z", "--stdin"], paths.map((f) => `${f}\0`).join(""), [0, 1]).pipe(Effect.map(nul))

const worktreeIncludes = Effect.fn("worktreeIncludes")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const include = path.join(root, ".worktreeinclude")
  if (!(yield* fs.exists(include))) return []
  const named = nul(
    yield* gitRaw(root, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${include}`]),
  ).filter((f) => !f.endsWith("/"))
  return yield* ignoredIn(root, named)
})

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
  for (const f of yield* worktreeIncludes(root)) {
    const dst = path.join(worktree, f)
    const taken = yield* Effect.gen(function* () {
      return (yield* linkOnPath(worktree, f)) || (yield* fs.exists(dst)) || Option.isSome(yield* linkTarget(dst))
    }).pipe(Effect.mapError(copyFailed(path.join(root, f), dst)))
    if (!taken) open.push(f)
  }
  const ignored = new Set(yield* ignoredIn(worktree, open))
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

export interface GitState {
  readonly branch: string
  readonly pushed: boolean
  readonly saved: boolean
  readonly why: string
}

export const gitState = Effect.fn("gitState")(function* (worktree: string) {
  if ((yield* gitDirectory(worktree)) === undefined) return undefined
  const branch = (yield* tryGit(worktree, "branch", "--show-current")) ?? ""
  const dirty = !!(yield* tryGit(worktree, "status", "--porcelain", "--untracked-files=all"))
  const contained =
    !!branch || !!(yield* tryGit(worktree, "for-each-ref", "--contains", "HEAD", "refs/heads", "refs/remotes"))
  const upstream = branch ? yield* tryGit(worktree, "rev-parse", "--abbrev-ref", "@{upstream}") : undefined
  const pushed = !!upstream && (yield* tryGit(worktree, "rev-list", "--count", "@{upstream}..HEAD")) === "0"
  const why = dirty ? "uncommitted changes" : !contained ? "commits not on any branch" : ""
  return { branch, pushed, saved: !why, why } satisfies GitState
})
