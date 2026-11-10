import { Clock, Effect } from "effect"
import { SqlClient } from "effect/sql"

import { MIGRATION_TABLE } from "../db-schema.ts"
import { append, installLedger } from "../journal.ts"
import { ledgerReads } from "../ledger-read.ts"
import { compare, type InboxColumns, type Reader, type SessionColumns, viewOf } from "./referee.ts"
import { type Counts, ImportFailed, type Translation, translate } from "./translate.ts"
import { probesOf, readSnapshot, type Snapshot, v1Reader } from "./v1-read.ts"

export { ImportFailed } from "./translate.ts"

export type Report = {
  readonly events: number
  readonly facts: number
  readonly ms: number
  readonly counts: Counts
  readonly differences: ReadonlyArray<string>
}

const describe = (cause: unknown): string =>
  cause instanceof Error
    ? cause.cause === undefined
      ? cause.message
      : `${cause.message} (${describe(cause.cause)})`
    : String(cause)

const failed = (what: string) => (cause: unknown) =>
  cause instanceof ImportFailed ? cause : new ImportFailed({ message: `${what}: ${describe(cause)}` })

export const v2Reader = (sql: SqlClient.SqlClient): Reader => ({
  ...ledgerReads(sql),

  inboxColumns: sql<InboxColumns>`SELECT id, kind, recipient_session_id AS recipient, sender_session_id AS sender,
      content, status, turn_id AS turn FROM inbox ORDER BY id`,
  sessionColumns: sql<SessionColumns & { readonly id: string }>`SELECT id, project_id, parent_session_id,
      report_to_session_id, role, name, directory, archive_on_completion, created_at, ended_at, origin_peer,
      origin_project, origin_parent, origin_report_to
    FROM session`,
  projects: Effect.gen(function* () {
    const projects = yield* sql<{ id: string; directory: string | null; entrySessionId: string | null }>`SELECT id,
        directory, entry_session_id FROM project`
    const repositories = yield* sql<{ projectId: string; path: string; remoteUrl: string | null }>`SELECT project_id,
        path, remote_url FROM project_repository ORDER BY path`
    return projects.map((p) => ({
      ...p,
      repositories: repositories
        .filter((r) => r.projectId === p.id)
        .map((r) => ({ path: r.path, remoteUrl: r.remoteUrl })),
    }))
  }),
})

const translated = (snapshot: Snapshot) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    return yield* Effect.try({ try: () => translate(snapshot, now), catch: failed("translating the v1 database") })
  })

const v1View = (sql: SqlClient.SqlClient, snapshot: Snapshot, translation: Translation) =>
  viewOf(
    v1Reader(sql, snapshot, {
      event: (id) => translation.eventSeq.get(id) ?? -id,
      inbox: (id) => translation.inboxSeq.get(id) ?? -id,
    }),
    probesOf(snapshot),
  ).pipe(Effect.mapError(failed("reading the v1 database")))

const load = (translation: Translation) =>
  Effect.forEach(
    translation.facts,
    (fact) => append(fact).pipe(Effect.mapError(failed(translation.sources.get(fact.seq) ?? `event ${fact.seq}`))),
    { discard: true },
  )

const judged = (
  sql: SqlClient.SqlClient,
  snapshot: Snapshot,
  translation: Translation,
  v1: Effect.Success<ReturnType<typeof v1View>>,
  started: number,
) =>
  Effect.gen(function* () {
    const v2 = yield* viewOf(v2Reader(sql), probesOf(snapshot)).pipe(Effect.mapError(failed("reading the v2 database")))
    return {
      events: snapshot.events.length,
      facts: translation.facts.length,
      ms: (yield* Clock.currentTimeMillis) - started,
      counts: translation.counts,
      differences: compare(v1, v2),
    } satisfies Report
  })

export const importCheck = (source: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const scratch = yield* SqlClient.SqlClient
    const started = yield* Clock.currentTimeMillis
    const { snapshot, translation, v1 } = yield* source
      .withTransaction(
        Effect.gen(function* () {
          const snapshot = yield* readSnapshot(source)
          const translation = yield* translated(snapshot)
          return { snapshot, translation, v1: yield* v1View(source, snapshot, translation) }
        }),
      )
      .pipe(Effect.mapError(failed("reading the v1 database")))
    yield* scratch
      .withTransaction(Effect.andThen(installLedger, load(translation)))
      .pipe(Effect.mapError(failed("loading the translated events")))
    return yield* judged(scratch, snapshot, translation, v1, started)
  })

const dropAll = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ${MIGRATION_TABLE}`
    yield* sql.unsafe("PRAGMA defer_foreign_keys = ON")
    for (const table of tables) yield* sql.unsafe(`DROP TABLE "${table.name}"`)
  })

export const refereeFailed = (report: Report) =>
  new ImportFailed({
    message: [
      `the imported database does not read back like the v1 database (first ${report.differences.length} differences):`,
      ...report.differences,
    ].join("\n"),
  })

export const importInPlace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const started = yield* Clock.currentTimeMillis
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const snapshot = yield* readSnapshot(sql)
        const translation = yield* translated(snapshot)
        const v1 = yield* v1View(sql, snapshot, translation)
        yield* dropAll(sql)
        yield* installLedger
        yield* load(translation)
        const report = yield* judged(sql, snapshot, translation, v1, started)
        if (report.differences.length > 0) return yield* refereeFailed(report)
        return report
      }),
    )
    .pipe(Effect.mapError(failed("importing the v1 database")))
})
