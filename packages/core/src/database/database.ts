import { messageOf } from "@vibest/schema/error"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, FileSystem, Layer, Predicate, Schedule, String as Str } from "effect"
import { SqlClient, SqlError } from "effect/sql"

import { PlatformNode } from "../effect/platform.ts"
import { open } from "./migration.ts"
import { DatabaseOpenFailed } from "./schema.sql.ts"

export * as Database from "./database.ts"

export const SQL_NAMES = { transformQueryNames: Str.camelToSnake, transformResultNames: Str.snakeToCamel } as const

export const PRIVATE_FILE = 0o600

const LOCK_RETRY = Schedule.spaced("10 millis").pipe(Schedule.upTo({ duration: "5 seconds" }))

const retryLockTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.retry(effect, {
    while: (error) => SqlError.isSqlError(error) && Predicate.isTagged(error.reason, "LockTimeoutError"),
    schedule: LOCK_RETRY,
  })

export const restrictToOwner = Effect.fn("Database.restrictToOwner")(function* (filename: string) {
  if (filename === ":memory:") return
  const fs = yield* FileSystem.FileSystem

  yield* Effect.gen(function* () {
    if (!(yield* fs.exists(filename))) {
      yield* fs.writeFile(filename, new Uint8Array())
    }

    yield* fs.chmod(filename, PRIVATE_FILE)

    for (const suffix of ["-wal", "-shm"]) {
      yield* fs
        .chmod(`${filename}${suffix}`, PRIVATE_FILE)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void))
    }
  }).pipe(Effect.mapError((error) => new DatabaseOpenFailed({ file: filename, message: messageOf(error) })))
})

export interface Interface {
  readonly sql: SqlClient.SqlClient
}

export class Service extends Context.Service<Service, Interface>()("vibest/Database") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* open()
    yield* sql.unsafe("PRAGMA foreign_keys = ON")
    yield* retryLockTimeout(sql.unsafe("PRAGMA journal_mode = WAL"))
    yield* sql.unsafe("PRAGMA synchronous = NORMAL")
    yield* sql`UPDATE kv SET value = value WHERE key = ''`

    return Service.of({ sql })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [PlatformNode.sqlClient],
})
