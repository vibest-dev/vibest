import type { SessionRef } from "@vibest/schema/terminal"
import { Context, Effect, Layer } from "effect"

import type { SessionRow } from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { resolveEdgeRefs } from "../database/session-edges.ts"
import { LayerNode } from "../effect/layer-node.ts"

export * as Summaries from "./summaries.ts"

export const make = Effect.gen(function* () {
  const db = yield* Db.Service

  const summary = (row: SessionRow, to: ReadonlyArray<SessionRef>) =>
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
        projectId: row.projectId,
        agent: row.agent,
        title: row.name,
        parentId: row.parentId,
        to,
        status: row.status,
        lastActive: row.lastActive,
        waiting: row.openExecution !== null || (yield* db.inbox.waitingOn(row.id)),
        latest,
      }
    })

  const machineMap = () =>
    db.remote.machines.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.remoteId, row.name]))))

  return {
    list: () =>
      Effect.gen(function* () {
        const rows = yield* db.session.listSessions()
        const edges = yield* db.session.sessionEdges(rows.map((row) => row.id))
        const machineByRemote = yield* machineMap()

        return yield* Effect.forEach(rows, (row) =>
          summary(row, resolveEdgeRefs(edges.get(row.id) ?? [], machineByRemote)),
        )
      }),
    get: (id: string) =>
      Effect.gen(function* () {
        const row = yield* db.session.getSession(id)

        if (row === undefined) return undefined
        const edges = yield* db.session.sessionEdges([row.id])
        const machineByRemote = yield* machineMap()

        return yield* summary(row, resolveEdgeRefs(edges.get(row.id) ?? [], machineByRemote))
      }),
    sentIn: db.inbox.sentIn,
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Summaries") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({ service: Service, layer, deps: [Db.node] })
