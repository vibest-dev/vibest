import { Context, Effect, Layer, String as Str } from "effect"
import { SqlClient } from "effect/sql"

import { Bus } from "../bus.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { PlatformNode } from "../effect/platform.ts"
import { SessionLive } from "../session/live.ts"
import * as Inbox from "./inbox.ts"
import { apply } from "./migration.ts"
import * as Project from "./project.ts"
import * as Projectors from "./projectors.ts"
import * as Remote from "./remote.ts"
import * as SessionStatements from "./session-statements.ts"
import * as Session from "./session.ts"

export type { SessionFilter } from "./session.ts"

export interface Interface {
  readonly project: Project.Interface
  readonly session: Session.Interface
  readonly inbox: Inbox.Interface
  readonly remote: Remote.Interface
}

const make = Effect.gen(function* () {
  const session = yield* SessionStatements.statements
  const remote = yield* Remote.statements
  const inbox = yield* Inbox.statements(session, remote)
  return {
    project: yield* Project.make,
    session: yield* Session.make(session, inbox, remote),
    inbox: yield* Inbox.make(session, inbox),
    remote: yield* Remote.make(session, inbox, remote),
  } satisfies Interface
})

export const SQL_NAMES = { transformQueryNames: Str.camelToSnake, transformResultNames: Str.snakeToCamel } as const

export class Db extends Context.Service<Db, Interface>()("vibest/Db") {
  static readonly layer = Layer.effect(
    Db,
    SqlClient.SqlClient.pipe(
      Effect.andThen(apply),
      Effect.andThen(SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql.unsafe("PRAGMA journal_mode = WAL")))),
      Effect.andThen(SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql.unsafe("PRAGMA synchronous = NORMAL")))),
      Effect.andThen(
        SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql`UPDATE meta SET value = value WHERE key = ''`)),
      ),
      Effect.andThen(make),
    ),
  )

  static readonly node = LayerNode.make({
    service: Db,
    layer: Db.layer,
    deps: [Bus.node, Projectors.node, SessionLive.node, PlatformNode.sqlClient],
  })
}
