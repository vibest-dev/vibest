import { ID } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import { NoSuchProject } from "@vibest/schema/project"
import { type WorktreeList, type WorktreeRepository, type WorktreeSession } from "@vibest/schema/worktree"
import { Effect, FileSystem, Path } from "effect"

import { Db } from "./database/db.ts"
import { Git } from "./git.ts"
import { ALLOCATION_LEAF } from "./paths.ts"
import { listProjectRepositories } from "./project/create.ts"
import { locateProject } from "./project/identity.ts"

const real = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.realPath(file).pipe(Effect.orElseSucceed(() => file)))

const namesIn = (dir: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readDirectory(dir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
  )

const repositoryAt = Effect.fn("Worktree.repository")(function* (folder: string) {
  const git = yield* Git.Service
  const known = yield* git.state(folder).pipe(Effect.orElseSucceed(() => undefined))

  if (known === undefined) return { folder, state: "unknown" as const } satisfies WorktreeRepository

  const changed = yield* git.uncommitted(folder).pipe(
    Effect.map((lines) => lines.length),
    Effect.orElseSucceed(() => undefined),
  )

  const commit =
    known.branch === "" ? yield* git.head(folder).pipe(Effect.catchTag("GitError", () => Effect.succeed(""))) : ""

  const head = known.branch !== "" ? { branch: known.branch } : commit !== "" ? { commit } : undefined

  const state =
    changed === undefined
      ? "unknown"
      : changed > 0
        ? "dirty"
        : known.why === "commits not on any branch"
          ? "unsaved"
          : known.saved
            ? "clean"
            : "unknown"

  return {
    folder,
    ...(head !== undefined && head),
    state,
    ...(changed !== undefined && changed > 0 && { changed }),
  } satisfies WorktreeRepository
})

const checkoutOf = (dir: string) =>
  Git.Service.use((git) => git.mainCheckout(dir)).pipe(
    Effect.flatMap((main) => real(main)),
    Effect.orElseSucceed(() => undefined),
  )

const placesOf = Effect.fn("Worktree.places")(function* (dir: string) {
  const children = yield* listProjectRepositories(dir).pipe(Effect.orElseSucceed(() => undefined))

  if (children) {
    const places: Array<{ readonly folder: string; readonly main: string }> = []

    for (const child of children) {
      const main = yield* checkoutOf(child.path)

      if (main === undefined) return undefined
      places.push({ folder: yield* real(child.path), main })
    }

    return places
  }

  const main = yield* checkoutOf(dir)

  if (main === undefined) return undefined

  return [{ folder: yield* real(dir), main }]
})

const rootOf = (folder: string) =>
  locateProject(folder).pipe(
    Effect.map((at) => at.root),
    Effect.catchTag("NotInRepository", () => Effect.succeed(folder)),
    Effect.catchTag("PlatformError", () => Effect.succeed(folder)),
  )

const byPath = <A extends { readonly path: string }>(rows: Array<A>) =>
  rows.sort((a, b) => a.path.localeCompare(b.path))

const byId = <A extends { readonly id: string }>(rows: Array<A>) => rows.sort((a, b) => a.id.localeCompare(b.id))

export const list = Effect.fn("Worktree.list")(function* (project: string | undefined) {
  const db = yield* Db.Service
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const layout = yield* Layout

  const recorded = (yield* db.project.watchProjects()).flatMap((row) =>
    row.directory === null ? [] : [{ id: row.id, directory: row.directory }],
  )

  const chosen = yield* Effect.gen(function* () {
    if (project === undefined) return recorded

    if (ID.test(project)) {
      const found = recorded.filter((row) => row.id === project)

      if (found.length === 0) return yield* new NoSuchProject({ project })

      return found
    }

    const given = yield* fs.realPath(project).pipe(Effect.orElseSucceed(() => project))
    const root = yield* rootOf(given)
    const found: Array<(typeof recorded)[number]> = []

    for (const row of recorded) {
      const directory = yield* real(row.directory)

      if (directory === root || directory === given || row.directory === project) found.push(row)
    }

    if (found.length === 0) return yield* new NoSuchProject({ project })

    return found
  })

  const owners = new Map<string, string>()

  for (const row of chosen) {
    for (const repository of yield* db.project.projectRemote(row.id)) owners.set(yield* real(repository.path), row.id)
  }

  const sessionsAt = new Map<string, Array<WorktreeSession & { readonly projectId: string }>>()

  for (const row of yield* db.session.worktreeSessions()) {
    const at = yield* real(row.directory)

    const session = {
      id: row.id,
      title: row.name,
      state: row.endedAt === null ? ("live" as const) : ("archived" as const),
      projectId: row.projectId,
    }

    const listed = sessionsAt.get(at)

    if (listed === undefined) sessionsAt.set(at, [session])
    else listed.push(session)
  }

  const grouped = new Map<
    string,
    Array<{ path: string; repositories: WorktreeRepository[]; sessions: WorktreeSession[] }>
  >()

  for (const bucket of (yield* namesIn(layout.worktrees)).slice().sort()) {
    const parent = path.join(layout.worktrees, bucket)

    for (const leaf of (yield* namesIn(parent)).slice().sort()) {
      if (!ALLOCATION_LEAF.test(leaf)) continue
      const dir = path.join(parent, leaf)

      const info = yield* fs.stat(dir).pipe(Effect.orElseSucceed(() => undefined))

      if (info === undefined || info.type !== "Directory") continue
      const at = yield* real(dir)
      const places = yield* placesOf(at)

      if (places === undefined || places.length === 0) continue
      let projectId: string | undefined

      for (const place of places) {
        const id = owners.get(place.main)

        if (id === undefined || (projectId !== undefined && projectId !== id)) {
          projectId = undefined
          break
        }

        projectId = id
      }

      if (projectId === undefined) continue
      const repositories: WorktreeRepository[] = []

      for (const place of places) repositories.push(yield* repositoryAt(place.folder))
      const sessions: WorktreeSession[] = []

      for (const session of sessionsAt.get(at) ?? []) {
        if (session.projectId !== projectId) continue
        sessions.push({ id: session.id, title: session.title, state: session.state })
      }

      const worktree = { path: at, repositories, sessions: byId(sessions) }
      const listed = grouped.get(projectId)

      if (listed === undefined) grouped.set(projectId, [worktree])
      else listed.push(worktree)
    }
  }

  const projects = []

  for (const row of chosen) {
    const worktrees = byPath(grouped.get(row.id) ?? [])

    if (worktrees.length === 0 && project === undefined) continue
    projects.push({ id: row.id, directory: row.directory, worktrees })
  }

  return { projects } satisfies WorktreeList
})
