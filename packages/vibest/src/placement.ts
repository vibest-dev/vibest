import { PlacementPolicy } from "@vibest/core/placement"
// vibest's terminal placement policy (core/placement.ts `PlacementPolicy`): a session's terminal opens beside the lead
// that started it, else beside the project's main agent; the project's workspace is labelled with the project's name
// and how many of its sessions are live.
import { Storage } from "@vibest/core/storage"
import { Workspace } from "@vibest/core/workspace"
import { Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"

import { repositoryDirectoryName } from "./worktree.ts"

export const layer = Layer.effect(
  PlacementPolicy,
  Effect.gen(function* () {
    const db = yield* Storage
    const workspace = yield* Workspace
    const platform = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >()
    const path = yield* Path.Path

    /** The project directory stored on the main agent, if its start wrote one. Never the lookup key. */
    const stored = (scope: string) => db.ownerOf(scope).pipe(Effect.map((main) => main?.directory))

    /** Project name on the workspace: the directory's own name, not the key. */
    const projectName = (root: string) =>
      repositoryDirectoryName(root).pipe(
        Effect.provideContext(platform),
        Effect.catch(() => Effect.succeed(path.basename(root))),
      )

    const liveCount = (scope: string) =>
      db
        .listSessions({ scope })
        .pipe(Effect.map((rows) => rows.filter((row) => !(row.metadata.archived || row.metadata.removed)).length))

    return PlacementPolicy.of({
      // Beside whoever started the session: a session that spawned it (a lead) when its terminal is in this same
      // runtime, else the project's main agent's terminal when that one is (pane ids are the runtime's own).
      near: (session, kind) =>
        Effect.gen(function* () {
          const parent = yield* db.parentOf(session.id)
          const lead = parent === undefined ? undefined : yield* db.getSession(parent)
          if (lead?.runtime === kind && lead.exitedAt === null && lead.address.id !== "") return lead.address
          const main = yield* db.ownerOf(session.scope)
          return main?.runtime === kind && main.address !== null && main.address.id !== "" ? main.address : undefined
        }),
      root: (session, cwd) =>
        Effect.gen(function* () {
          const dir = yield* stored(session.scope)
          if (yield* workspace.repositories(cwd)) return dir ?? (yield* workspace.project(cwd)).root
          return dir ?? (yield* workspace.mainCheckout(cwd))
        }),
      labelRoot: (session, cwd) =>
        Effect.gen(function* () {
          return (yield* stored(session.scope)) ?? (yield* workspace.project(cwd)).root
        }),
      labels: (scope, root) =>
        Effect.gen(function* () {
          return { project: yield* projectName(root), live: String(yield* liveCount(scope)) }
        }),
      // shortcut: without a stored project directory the workspace's project token cannot be named again, so it is left as it is
      alone: (scope, kind, live) =>
        Effect.gen(function* () {
          const main = yield* db.ownerOf(scope)
          const dir = yield* stored(scope)
          if (main?.runtime !== kind || !main.address || main.address.id === "" || dir === undefined) return undefined
          return { terminal: main.address, labels: { project: yield* projectName(dir), live: String(live) } }
        }),
    })
  }),
)
