import { ProjectCreated, ProjectMoved, ProjectRepositoriesChanged } from "@vibest/schema/event"
import { newId } from "@vibest/schema/id"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import { Bus } from "../bus.ts"
import { type RepositoryRow } from "./db-rows.ts"

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { publish, observe, transaction: tx } = yield* Bus

  const projectPrefixTaken = (short: string) =>
    sql`SELECT 1 FROM project WHERE id >= ${short} AND id < ${`${short}~`} LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    )

  const repositoriesOf = (repositories: ReadonlyArray<RepositoryRow>) =>
    repositories.map((r) => ({ path: r.path, ...(r.remote ? { remote: r.remote } : {}) }))

  const changedRepositories = (id: string, repositories: ReadonlyArray<RepositoryRow>) =>
    Effect.gen(function* () {
      const changed: Array<RepositoryRow> = []
      for (const r of repositories) {
        const [row] = yield* sql<{ projectId: string; remoteUrl: string | null }>`SELECT project_id, remote_url
          FROM project_repository WHERE path = ${r.path}`
        if (row === undefined || (row.projectId === id && row.remoteUrl !== (r.remote || null))) changed.push(r)
      }
      return repositoriesOf(changed)
    })

  return {
    projectAt: (root: string) =>
      sql<{ id: string; directory: string }>`SELECT id, directory FROM project WHERE directory = ${root}
        UNION ALL SELECT p.id, p.directory FROM project_repository r JOIN project p ON p.id = r.project_id
          WHERE r.path = ${root} LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),

    createProject: (directory: string, repositories: ReadonlyArray<RepositoryRow>) =>
      tx(
        Effect.gen(function* () {
          const [existing] = yield* sql<{ id: string }>`SELECT id FROM project WHERE directory = ${directory}`
          if (existing !== undefined) {
            const changed = yield* changedRepositories(existing.id, repositories)
            if (changed.length > 0)
              yield* publish(ProjectRepositoriesChanged, { projectId: existing.id, data: { repositories: changed } })
          } else {
            const id = yield* newId(projectPrefixTaken)
            yield* publish(ProjectCreated, {
              projectId: id,
              data: { ...(directory ? { directory } : {}), repositories: repositoriesOf(repositories) },
            })
          }
          const [row] = yield* sql<{ id: string }>`SELECT id FROM project WHERE directory = ${directory}`
          return row!.id
        }),
      ).pipe(Effect.orDie),

    refreshRepositories: (id: string, repositories: ReadonlyArray<RepositoryRow>) =>
      tx(
        Effect.gen(function* () {
          const changed = yield* changedRepositories(id, repositories)
          if (changed.length > 0)
            yield* publish(ProjectRepositoriesChanged, { projectId: id, data: { repositories: changed } })
        }),
      ).pipe(Effect.orDie),

    moveCandidates: (remotes: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const wanted = [...new Set(remotes)].sort()
        if (wanted.length === 0) return []
        const rows = yield* sql<{ id: string; directory: string; remote: string | null }>`SELECT p.id, p.directory,
            r.remote_url AS remote FROM project p JOIN project_repository r ON r.project_id = p.id
          WHERE p.directory IS NOT NULL AND p.id IN (SELECT project_id FROM project_repository WHERE ${sql.in("remote_url", wanted)})`
        const byProject = new Map<string, { directory: string; remotes: Set<string> }>()
        for (const row of rows) {
          const entry = byProject.get(row.id) ?? { directory: row.directory, remotes: new Set<string>() }
          if (row.remote !== null) entry.remotes.add(row.remote)
          byProject.set(row.id, entry)
        }
        return [...byProject]
          .filter(([, p]) => [...p.remotes].sort().join("\n") === wanted.join("\n"))
          .map(([id, p]) => ({ id, directory: p.directory }))
      }).pipe(Effect.orDie),

    moveProject: (id: string, to: string, repositories: ReadonlyArray<RepositoryRow>) =>
      tx(
        Effect.gen(function* () {
          const [row] = yield* sql<{ directory: string }>`SELECT directory FROM project WHERE id = ${id}`
          const from = row!.directory
          yield* publish(ProjectMoved, {
            projectId: id,
            data: { from, to, repositories: repositoriesOf(repositories) },
          })
          for (const session of yield* sql<{
            id: string
          }>`SELECT id FROM session WHERE project_id = ${id} AND ended_at IS NULL`)
            yield* observe({ type: "session.changed", sessionId: session.id })
          return from
        }),
      ).pipe(Effect.orDie),

    watchProjects: (id?: string) =>
      sql<{ id: string; directory: string | null; entrySessionId: string | null }>`SELECT id, directory,
          entry_session_id FROM project WHERE directory IS NOT NULL ${id === undefined ? sql`` : sql`AND id = ${id}`}
          ORDER BY rowid`.pipe(Effect.orDie),

    projectDirectory: (id: string) =>
      sql<{ directory: string | null }>`SELECT directory FROM project WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]?.directory ?? undefined),
        Effect.orDie,
      ),

    projectRemote: (projectId: string) =>
      sql<{ path: string; remote: string | null }>`SELECT path, remote_url AS remote FROM project_repository
        WHERE project_id = ${projectId} ORDER BY rowid`.pipe(Effect.orDie),
  }
})

export type Interface = Effect.Success<typeof make>
