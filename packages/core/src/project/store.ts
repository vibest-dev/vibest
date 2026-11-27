import { newId } from "@vibest/schema/id"
import { ProjectEvent } from "@vibest/schema/project-event"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, Layer } from "effect"

import { Bus, SessionChanged } from "../bus.ts"
import { Database } from "../database/database.ts"
import { type RepositoryRow } from "../database/rows.ts"
import { Projectors } from "../reactor.ts"
import { projectSql, repositoriesOf } from "./sql.ts"

export * as ProjectStore from "./store.ts"

export const make = Effect.gen(function* () {
  const { sql } = yield* Database.Service
  const { publish, transaction: tx } = yield* Bus.Service
  const { projectPrefixTaken, changedRepositories } = projectSql(sql)

  return {
    projectAt: Effect.fn("ProjectStore.projectAt")((root: string) =>
      sql<{ id: string; directory: string }>`SELECT id, directory FROM project WHERE directory = ${root}
        UNION ALL SELECT p.id, p.directory FROM project_repository r JOIN project p ON p.id = r.project_id
          WHERE r.path = ${root} LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),
    ),

    createProject: Effect.fn("ProjectStore.createProject")(
      (directory: string, repositories: ReadonlyArray<RepositoryRow>) =>
        tx(
          Effect.gen(function* () {
            const [existing] = yield* sql<{ id: string }>`SELECT id FROM project WHERE directory = ${directory}`

            if (existing !== undefined) {
              const changed = yield* changedRepositories(existing.id, repositories)

              if (changed.length > 0)
                yield* publish(ProjectEvent.RepositoriesChanged, { projectId: existing.id, repositories: changed })
            } else {
              const id = yield* newId(projectPrefixTaken)
              yield* publish(ProjectEvent.Created, {
                projectId: id,
                ...(directory && { directory }),
                repositories: repositoriesOf(repositories),
              })
            }

            const [row] = yield* sql<{ id: string }>`SELECT id FROM project WHERE directory = ${directory}`

            return row!.id
          }),
        ).pipe(Effect.orDie),
    ),

    refreshRepositories: Effect.fn("ProjectStore.refreshRepositories")(
      (id: string, repositories: ReadonlyArray<RepositoryRow>) =>
        tx(
          Effect.gen(function* () {
            const changed = yield* changedRepositories(id, repositories)

            if (changed.length > 0)
              yield* publish(ProjectEvent.RepositoriesChanged, { projectId: id, repositories: changed })
          }),
        ).pipe(Effect.orDie),
    ),

    moveProject: Effect.fn("ProjectStore.moveProject")(
      (id: string, to: string, repositories: ReadonlyArray<RepositoryRow>) =>
        tx(
          Effect.gen(function* () {
            const [row] = yield* sql<{ directory: string }>`SELECT directory FROM project WHERE id = ${id}`
            const from = row!.directory
            yield* publish(ProjectEvent.Moved, {
              projectId: id,
              from,
              to,
              repositories: repositoriesOf(repositories),
            })

            for (const session of yield* sql<{
              id: string
            }>`SELECT id FROM session WHERE project_id = ${id} AND ended_at IS NULL`)
              yield* publish(SessionChanged, { sessionId: session.id })

            return from
          }),
        ).pipe(Effect.orDie),
    ),

    watchProjects: Effect.fn("ProjectStore.watchProjects")((id?: string) =>
      sql<{ id: string; directory: string | null }>`SELECT id, directory
          FROM project WHERE directory IS NOT NULL ${id === undefined ? sql`` : sql`AND id = ${id}`}
          ORDER BY rowid`.pipe(Effect.orDie),
    ),

    projectDirectory: Effect.fn("ProjectStore.projectDirectory")((id: string) =>
      sql<{ directory: string | null }>`SELECT directory FROM project WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]?.directory ?? undefined),
        Effect.orDie,
      ),
    ),

    projectRemote: Effect.fn("ProjectStore.projectRemote")((projectId: string) =>
      sql<{ path: string; remote: string | null }>`SELECT path, remote_url AS remote FROM project_repository
        WHERE project_id = ${projectId} ORDER BY rowid`.pipe(Effect.orDie),
    ),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/ProjectStore") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Bus.node, Projectors.node],
})
