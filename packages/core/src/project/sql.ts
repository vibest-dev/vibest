import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

import type { RepositoryRow } from "../database/rows.ts"

export const repositoriesOf = (repositories: ReadonlyArray<RepositoryRow>) =>
  repositories.map((r) => ({ path: r.path, ...(r.remote && { remote: r.remote }) }))

export const projectSql = (sql: SqlClient.SqlClient) => {
  const projectPrefixTaken = (short: string) =>
    sql`SELECT 1 FROM project WHERE id >= ${short} AND id < ${`${short}~`} LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
    )

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

  return { projectPrefixTaken, changedRepositories }
}
