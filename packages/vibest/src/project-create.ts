// `vibest project create <directory> --from <repository>…` (architecture D7, §3 Project and Workspace; plan phase 7):
// copy each git repository into one new directory as a folder named after it, and one detached worktree per repository
// for a writing subagent's isolated Workspace.
import { safeRepositoryDirectory, sameWorktreeBucket } from "@vibest/core/paths"
import type { ProjectRepository, RepositoryGit } from "@vibest/core/workspace"
import { Effect, Exit, FileSystem, Option, Path, Schema } from "effect"

import { addWorktree, copyIncluded, git, gitState, mainCheckout, repositoryDirectoryName } from "./worktree.ts"

export class ProjectCreateFailed extends Schema.TaggedError<ProjectCreateFailed>()("ProjectCreateFailed", {
  message: Schema.String,
}) {}

export interface ProjectFolder {
  /** Folder name in the project directory: origin's repository name, else the source checkout's directory name. */
  readonly name: string
  /** The source checkout's top level (absolute). */
  readonly source: string
  /** The copy: `<directory>/<name>`. */
  readonly path: string
  /** The source's current branch, checked out in the copy. */
  readonly branch: string
  /** The source's `remote.origin.url`, now the copy's origin; undefined when the source has none (the copy has no remote). */
  readonly origin: string | undefined
  /** `git status --porcelain` lines of the source: uncommitted changes that were not copied. */
  readonly uncommitted: ReadonlyArray<string>
}

export interface CreatedProject {
  readonly directory: string
  readonly folders: ReadonlyArray<ProjectFolder>
}

const optionalGit = (cwd: string, ...args: string[]) => git(cwd, ...args).pipe(Effect.orElseSucceed(() => undefined))

/** The source checkout and what is copied from it; reads only. */
const inspect = (directory: string, given: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const refuse = (why: string) => new ProjectCreateFailed({ message: `${given}: ${why}` })
    const absolute = path.resolve(given)
    const info = yield* fs.stat(absolute).pipe(Effect.mapError(() => refuse("not found")))
    if (info.type !== "Directory") return yield* refuse("not a directory")
    const top = yield* git(absolute, "rev-parse", "--show-toplevel").pipe(
      Effect.mapError(() => refuse("not a git repository")),
    )
    const source = yield* fs.realPath(top).pipe(Effect.mapError((e) => refuse(e.message)))
    const inside = path.relative(source, directory)
    if (!inside.startsWith("..") && !path.isAbsolute(inside))
      return yield* refuse(`${directory} would be inside this repository`)
    const branch = yield* git(source, "branch", "--show-current").pipe(Effect.mapError((e) => refuse(e.message)))
    if (!branch) return yield* refuse("HEAD is detached; switch to a branch first")
    const name = yield* repositoryDirectoryName(source).pipe(Effect.mapError((e) => refuse(e.message)))
    if (!safeRepositoryDirectory(name))
      return yield* refuse(`repository name ${JSON.stringify(name)} cannot be a folder name`)
    const origin = (yield* optionalGit(source, "config", "--get", "remote.origin.url")) || undefined
    // `--branch` puts a `## …` line first, so git's trimmed output keeps the next line's leading status space.
    const status = yield* git(source, "status", "--porcelain", "--branch", "--untracked-files=all").pipe(
      Effect.mapError((e) => refuse(e.message)),
    )
    const uncommitted = status.split("\n").slice(1).filter(Boolean)
    return { name, source, path: path.join(directory, name), branch, origin, uncommitted } satisfies ProjectFolder
  })

/**
 * An independent copy of `folder.source` at `folder.path`: its own objects (`--no-hardlinks`, no alternates), the
 * source's branch checked out, and origin set to the source's origin with the source's `origin/*` refs and upstream.
 * The local path the clone came from is not kept as a remote.
 */
const copy = (folder: ProjectFolder) =>
  Effect.gen(function* () {
    const { source, path: dest, branch, origin } = folder
    yield* git(source, "clone", "--quiet", "--no-hardlinks", "--branch", branch, "--", source, dest)
    // Drops the clone's tracking refs and upstream config pointing at the local source.
    yield* git(dest, "remote", "remove", "origin")
    if (origin === undefined) return
    yield* git(dest, "remote", "add", "origin", origin)
    yield* git(
      dest,
      "fetch",
      "--quiet",
      "--no-tags",
      "--",
      source,
      "+refs/remotes/origin/*:refs/remotes/origin/*",
      "^refs/remotes/origin/HEAD",
    )
    const head = yield* optionalGit(source, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    if (head?.startsWith("origin/"))
      yield* optionalGit(dest, "remote", "set-head", "origin", head.slice("origin/".length))
    if ((yield* optionalGit(source, "config", "--get", `branch.${branch}.remote`)) !== "origin") return
    const merge = yield* optionalGit(source, "config", "--get", `branch.${branch}.merge`)
    if (!merge) return
    yield* git(dest, "config", `branch.${branch}.remote`, "origin")
    yield* git(dest, "config", `branch.${branch}.merge`, merge)
  }).pipe(
    Effect.mapError(
      (e) => new ProjectCreateFailed({ message: `copy ${folder.source} -> ${folder.path}: ${e.message}` }),
    ),
  )

/**
 * Make `directory` (or use it when it is an empty directory) and copy each repository in `sources` into it. Everything
 * is checked before anything is written. On failure or interruption, only what this call created is removed: the
 * directory when it made it, otherwise the folders it made.
 */
export const createProject = Effect.fn("createProject")(function* (directory: string, sources: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const refuse = (message: string) => new ProjectCreateFailed({ message })
  if (sources.length === 0) return yield* refuse("at least one --from repository is needed")
  const target = path.resolve(directory)
  const existing = yield* fs.stat(target).pipe(
    Effect.map((info) => info.type),
    Effect.catchIf(
      (e) => e.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
    Effect.mapError((e) => refuse(`${target}: ${e.message}`)),
  )
  if (existing !== undefined && existing !== "Directory")
    return yield* refuse(`${target} exists and is not a directory`)
  if (
    existing === "Directory" &&
    (yield* fs.readDirectory(target).pipe(Effect.mapError((e) => refuse(e.message)))).length > 0
  )
    return yield* refuse(`${target} exists and is not empty`)
  // Compare against the real parent, so a source reached through a link is still seen as containing the directory.
  const parent = yield* fs
    .realPath(path.dirname(target))
    .pipe(Effect.mapError(() => refuse(`${path.dirname(target)} does not exist`)))
  const real = path.join(parent, path.basename(target))

  const folders: ProjectFolder[] = []
  for (const source of sources) {
    const folder = yield* inspect(real, source)
    const clash = folders.find((f) => sameWorktreeBucket(f.name, folder.name))
    if (clash)
      return yield* refuse(`${source} and ${clash.source} would both be the folder ${JSON.stringify(folder.name)}`)
    folders.push(folder)
  }

  const made: string[] = []
  const undo = Effect.suspend(() =>
    Effect.forEach(made.toReversed(), (p) => fs.remove(p, { recursive: true }).pipe(Effect.ignore), { discard: true }),
  )
  yield* Effect.gen(function* () {
    if (existing === undefined) {
      yield* fs.makeDirectory(real).pipe(Effect.mapError((e) => refuse(`${real}: ${e.message}`)))
      made.push(real)
    }
    for (const folder of folders) {
      if (existing !== undefined) made.push(folder.path)
      yield* copy(folder)
    }
  }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.uninterruptible(undo))))
  return { directory: real, folders } satisfies CreatedProject
})

export type { ProjectRepository, RepositoryGit }

/** True when `dir` is a git checkout whose toplevel is `dir` itself (a linked worktree counts; a subdirectory of one does not). */
const ownGitCheckout = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const top = yield* git(dir, "rev-parse", "--show-toplevel").pipe(Effect.option)
    if (Option.isNone(top)) return false
    return (yield* fs.realPath(top.value)) === (yield* fs.realPath(dir))
  })

/**
 * The direct child git repositories of `directory` when `directory` itself is not a git repository.
 * Undefined when it is a git repository (a single-repository project, even with nested repositories) or it has no
 * child git repository. Names that cannot be a worktree folder are skipped.
 */
export const listProjectRepositories = Effect.fn("listProjectRepositories")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const info = yield* fs.stat(directory).pipe(
    Effect.catchIf(
      (e) => e.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  )
  if (info === undefined || info.type !== "Directory") return undefined
  // A checkout, or any directory inside one, is a single-repository Project. `vendor/sdk` under a repository stays that repository.
  if ((yield* git(directory, "rev-parse", "--is-inside-work-tree").pipe(Effect.orElseSucceed(() => ""))) === "true")
    return undefined
  const found: ProjectRepository[] = []
  for (const name of (yield* fs.readDirectory(directory)).slice().sort()) {
    if (!safeRepositoryDirectory(name)) continue
    const child = path.join(directory, name)
    const stat = yield* fs.stat(child).pipe(
      Effect.catchIf(
        (e) => e.reason._tag === "NotFound",
        () => Effect.succeed(undefined),
      ),
    )
    if (stat === undefined || stat.type !== "Directory" || !(yield* ownGitCheckout(child))) continue
    const branch = yield* git(child, "branch", "--show-current").pipe(Effect.orElseSucceed(() => ""))
    found.push({ name, path: child, branch })
  }
  return found.length > 0 ? found : undefined
})

/** A main checkout: `git-dir` is `git-common-dir`. A linked worktree is not. */
const isMainCheckout = (dir: string) =>
  git(dir, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir").pipe(
    Effect.map((out) => {
      const [gitDir, common = ""] = out.split("\n")
      return gitDir !== "" && gitDir === common
    }),
    Effect.orElseSucceed(() => false),
  )

/**
 * The root of the project `directory` belongs to. A directory is a project when every child checkout is a main
 * checkout. A directory of linked worktrees is a Workspace: the project is the shared parent of those main checkouts,
 * not the workspace. Anything else is its own main checkout.
 */
export const projectRoot = Effect.fn("projectRoot")(function* (directory: string) {
  const children = yield* listProjectRepositories(directory)
  if (children) {
    const path = yield* Path.Path
    let mains = 0
    let linkedParent: string | undefined
    let same = true
    for (const child of children) {
      if (yield* isMainCheckout(child.path)) {
        mains++
        continue
      }
      const checkout = yield* mainCheckout(child.path).pipe(Effect.option)
      if (Option.isNone(checkout)) {
        same = false
        continue
      }
      const parent = path.dirname(checkout.value)
      if (linkedParent === undefined) linkedParent = parent
      else if (linkedParent !== parent) same = false
    }
    if (mains === children.length) return { root: directory }
    // One level: the shared parent is the project (its own checkouts), not another workspace.
    if (same && mains === 0 && linkedParent !== undefined) {
      const nested = yield* listProjectRepositories(linkedParent)
      let nestedMains = nested !== undefined
      if (nested) for (const child of nested) if (!(yield* isMainCheckout(child.path))) nestedMains = false
      if (nested && nestedMains) return { root: linkedParent }
      return { root: yield* mainCheckout(linkedParent) }
    }
  }
  return { root: yield* mainCheckout(directory) }
})

/** A repository of a project: its main checkout's realpath and `remote.origin.url` as git prints it (not identity). */
export interface RepositoryPlace {
  readonly path: string
  readonly remote: string | undefined
}

/**
 * The repositories of the project at `root` (as `projectRoot` returns it): the main checkout itself, or each direct
 * child repository's main checkout of a multi-repository project.
 */
export const projectRepositories = Effect.fn("projectRepositories")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const children = yield* listProjectRepositories(root)
  const checkouts = children
    ? yield* Effect.forEach(children, (child) => mainCheckout(child.path))
    : [yield* mainCheckout(root)]
  const places: RepositoryPlace[] = []
  for (const checkout of checkouts) {
    const path = yield* fs.realPath(checkout)
    if (places.some((place) => place.path === path)) continue
    places.push({ path, remote: (yield* optionalGit(path, "config", "--get", "remote.origin.url")) || undefined })
  }
  return places
})

/** Remove each worktree (from its repository, without force: it refuses on anything not clean), then `workspace` when it is empty. Never deletes a branch. */
const removeWorktrees = (
  worktrees: ReadonlyArray<{ readonly repository: string; readonly worktree: string }>,
  workspace: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    for (const { repository, worktree } of worktrees.toReversed())
      yield* git(repository, "worktree", "remove", worktree).pipe(Effect.ignore)
    const left = yield* fs.readDirectory(workspace).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    if (left.length === 0) yield* fs.remove(workspace, { recursive: true }).pipe(Effect.ignore)
  })

/**
 * One detached worktree per project folder (`addWorktree`) at `<workspace>/<folder name>`, then `copyIncluded`; no
 * branch is ever created, so a leftover `refs/heads/vibest/<name>` cannot fail it. On failure or interruption, only the
 * worktrees this call created are removed, then the workspace directory when it is empty. Returns their paths.
 */
export const createIsolatedWorktrees = Effect.fn("createIsolatedWorktrees")(function* (
  folders: ReadonlyArray<Pick<ProjectFolder, "name" | "path">>,
  workspace: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(workspace, { recursive: true })
  const made: Array<{ readonly repository: string; readonly worktree: string }> = []
  yield* Effect.gen(function* () {
    for (const folder of folders) {
      const worktree = path.join(workspace, folder.name)
      // Recorded before the add, so a failure or interrupt during it still removes whatever git left.
      made.push({ repository: folder.path, worktree })
      yield* addWorktree(folder.path, worktree)
      yield* copyIncluded(folder.path, worktree)
    }
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) ? Effect.void : Effect.uninterruptible(removeWorktrees(made, workspace)),
    ),
  )
  return made.map((entry) => entry.worktree)
})

/** Launch failed after the worktrees existed: remove each, then the workspace directory when it is empty. */
export const discardIsolatedWorktrees = Effect.fn("discardIsolatedWorktrees")(function* (workspace: string) {
  const folders = (yield* listProjectRepositories(workspace)) ?? []
  const entries = yield* Effect.forEach(folders, (folder) =>
    mainCheckout(folder.path).pipe(
      Effect.option,
      Effect.map((checkout) => ({ repository: Option.getOrElse(checkout, () => folder.path), worktree: folder.path })),
    ),
  )
  yield* removeWorktrees(entries, workspace)
})

/** Git state of each repository in a multi-repository workspace; undefined when `workspace` is not one. */
export const workspaceGit = Effect.fn("workspaceGit")(function* (workspace: string) {
  const folders = yield* listProjectRepositories(workspace)
  if (!folders) return undefined
  const lines: RepositoryGit[] = []
  for (const folder of folders) {
    const state = (yield* gitState(folder.path)) ?? {
      branch: "",
      pushed: false,
      saved: false,
      why: "git cannot read it",
    }
    lines.push({ name: folder.name, ...state })
  }
  return lines
})
