import { Context, Effect, Layer } from "effect"

import type { SessionRow } from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { LayerNode } from "../effect/layer-node.ts"

export * as Summaries from "./summaries.ts"

export const make = Effect.gen(function* () {
  const db = yield* Db.Service

  const summary = (row: SessionRow) =>
    Effect.gen(function* () {
      const last = row.lastExecution

      const latest =
        last === null || last.endedAt === null
          ? null
          : {
              execution: last.id,
              outcome: last.outcome,
              sent: yield* db.inbox.sentIn(row.id, last.id),
              endedAt: last.endedAt,
            }

      return {
        id: row.id,
        title: row.name,
        parentId: row.parentId,
        status: row.status,
        lastActive: row.lastActive,
        waiting: row.openExecution !== null || (yield* db.inbox.waitingOn(row.id)),
        latest,
      }
    })

  return {
    list: () => db.session.listSessions().pipe(Effect.flatMap(Effect.forEach(summary))),
    get: (id: string) =>
      db.session
        .getSession(id)
        .pipe(Effect.flatMap((row) => (row === undefined ? Effect.succeed(undefined) : summary(row)))),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Summaries") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({ service: Service, layer, deps: [Db.node] })
