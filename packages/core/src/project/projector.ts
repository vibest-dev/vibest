import {
  type FactOf,
  ProjectCreated,
  ProjectEntryChanged,
  ProjectMoved,
  ProjectRepositoriesChanged,
} from "@vibest/schema/event"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import { Bus } from "../bus.ts"

type Repositories = FactOf<"project.created">["data"]["repositories"]

const putRepositories = (sql: SqlClient.SqlClient, projectId: string, repositories: Repositories) =>
  Effect.forEach(
    repositories,
    (r) => sql`INSERT INTO project_repository (project_id, path, remote_url) VALUES (${projectId}, ${r.path},
        ${r.remote ?? null})
      ON CONFLICT (path) DO UPDATE SET remote_url = excluded.remote_url WHERE project_id = excluded.project_id`,
    { discard: true },
  )

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* Bus
    const sql = yield* SqlClient.SqlClient
    yield* bus.project(ProjectCreated, (fact) =>
      Effect.andThen(
        sql`INSERT INTO project (id, directory) VALUES (${fact.projectId!}, ${fact.data.directory ?? null})`,
        putRepositories(sql, fact.projectId!, fact.data.repositories),
      ),
    )
    yield* bus.project(ProjectMoved, (fact) =>
      Effect.gen(function* () {
        const id = fact.projectId!
        const { from, to } = fact.data
        yield* sql`UPDATE project SET directory = ${to} WHERE id = ${id}`
        yield* sql`DELETE FROM project_repository WHERE project_id = ${id}`
        yield* putRepositories(sql, id, fact.data.repositories)
        yield* sql`UPDATE session SET directory = ${to} || substr(directory, ${from.length + 1})
          WHERE project_id = ${id} AND (directory = ${from} OR substr(directory, 1, ${from.length + 1}) = ${`${from}/`})`
      }),
    )
    yield* bus.project(ProjectRepositoriesChanged, (fact) =>
      putRepositories(sql, fact.projectId!, fact.data.repositories),
    )
    yield* bus.project(
      ProjectEntryChanged,
      (fact) => sql`UPDATE project SET entry_session_id = ${fact.data.session ?? null} WHERE id = ${fact.projectId!}`,
    )
  }),
)
