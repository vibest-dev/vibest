import { ProjectCreateFailed } from "@vibest/protocol/rpc"
import { Effect, Exit, FileSystem, Option, Path } from "effect"

import { safeRepositoryDirectory, sameWorktreeBucket } from "./paths.ts"

export { ProjectCreateFailed }
import {
  addWorktree,
  copyIncluded,
  Git,
  gitState,
  mainCheckout,
  removeWorktree,
  repositoryDirectoryName,
  type GitState,
} from "./worktree.ts"

export interface ProjectFolder {
  readonly name: string
  readonly source: string
  readonly path: string
  readonly branch: string
  readonly origin: string | undefined
  readonly uncommitted: ReadonlyArray<string>
}

export interface CreatedProject {
  readonly directory: string
  readonly folders: ReadonlyArray<ProjectFolder>
}

const resolveAgainst = (path: Path.Path, base: string | undefined, given: string) =>
  base === undefined ? path.resolve(given) : path.resolve(base, given)

const inspect = (directory: string, given: string, base: string | undefined) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const refuse = (why: string) => new ProjectCreateFailed({ message: `${given}: ${why}` })
    const absolute = resolveAgainst(path, base, given)
    const info = yield* fs.stat(absolute).pipe(Effect.mapError(() => refuse("not found")))
    if (info.type !== "Directory") return yield* refuse("not a directory")
    const git = yield* Git
    const top = yield* git.topLevel(absolute).pipe(Effect.mapError(() => refuse("not a git repository")))
    const source = yield* fs.realPath(top).pipe(Effect.mapError((e) => refuse(e.message)))
    const inside = path.relative(source, directory)
    if (!inside.startsWith("..") && !path.isAbsolute(inside))
      return yield* refuse(`${directory} would be inside this repository`)
    const branch = yield* git.currentBranch(source).pipe(Effect.mapError((e) => refuse(e.message)))
    if (!branch) return yield* refuse("HEAD is detached; switch to a branch first")
    const name = yield* repositoryDirectoryName(source).pipe(Effect.mapError((e) => refuse(e.message)))
    if (!safeRepositoryDirectory(name))
      return yield* refuse(`repository name ${JSON.stringify(name)} cannot be a folder name`)
    const origin = yield* git.originUrl(source)
    const uncommitted = yield* git.uncommitted(source).pipe(Effect.mapError((e) => refuse(e.message)))
    return { name, source, path: path.join(directory, name), branch, origin, uncommitted } satisfies ProjectFolder
  })

const copy = (folder: ProjectFolder) =>
  Git.use((git) =>
    git.copyRepository({ source: folder.source, dest: folder.path, branch: folder.branch, origin: folder.origin }),
  ).pipe(
    Effect.mapError(
      (e) => new ProjectCreateFailed({ message: `copy ${folder.source} -> ${folder.path}: ${e.message}` }),
    ),
  )

export const createProject = Effect.fn("createProject")(function* (
  directory: string,
  sources: ReadonlyArray<string>,
  base?: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const refuse = (message: string) => new ProjectCreateFailed({ message })
  if (sources.length === 0) return yield* refuse("at least one --from repository is needed")
  const target = resolveAgainst(path, base, directory)
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
  const parent = yield* fs
    .realPath(path.dirname(target))
    .pipe(Effect.mapError(() => refuse(`${path.dirname(target)} does not exist`)))
  const real = path.join(parent, path.basename(target))

  const folders: ProjectFolder[] = []
  for (const source of sources) {
    const folder = yield* inspect(real, source, base)
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

export interface ProjectRepository {
  readonly name: string
  readonly path: string
  readonly branch: string
}

const ownGitCheckout = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const top = yield* Git.use((git) => git.topLevel(dir)).pipe(Effect.option)
    if (Option.isNone(top)) return false
    return (yield* fs.realPath(top.value)) === (yield* fs.realPath(dir))
  })

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
  const git = yield* Git
  if (yield* git.insideWorkTree(directory)) return undefined
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
    const branch = yield* git.currentBranch(child).pipe(Effect.orElseSucceed(() => ""))
    found.push({ name, path: child, branch })
  }
  return found.length > 0 ? found : undefined
})

const isMainCheckout = (dir: string) => Git.use((git) => git.isMainCheckout(dir))

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

export interface RepositoryPlace {
  readonly path: string
  readonly remote: string | undefined
}

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
    places.push({ path, remote: yield* Git.use((git) => git.originUrl(path)) })
  }
  return places
})

const removeWorktrees = (
  worktrees: ReadonlyArray<{ readonly repository: string; readonly worktree: string }>,
  workspace: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    for (const { repository, worktree } of worktrees.toReversed())
      yield* removeWorktree(repository, worktree).pipe(Effect.ignore)
    const left = yield* fs.readDirectory(workspace).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    if (left.length === 0) yield* fs.remove(workspace, { recursive: true }).pipe(Effect.ignore)
  })

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

export interface RepositoryGit extends GitState {
  readonly name: string
}

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
