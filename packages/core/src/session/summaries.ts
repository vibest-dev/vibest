import type { SessionRef } from "@vibest/schema/terminal"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, Layer } from "effect"

import type { SessionRow } from "../database/rows.ts"
import { InboxStore } from "../inbox/store.ts"
import { RemoteStore } from "../remote/store.ts"
import { resolveEdgeRefs } from "./sql-edges.ts"
import { SessionStore } from "./store.ts"

export * as Summaries from "./summaries.ts"

export const make = Effect.gen(function* () {
  const sessionStore = yield* SessionStore.Service
  const inboxStore = yield* InboxStore.Service
  const remoteStore = yield* RemoteStore.Service

  const summary = (row: SessionRow, to: ReadonlyArray<SessionRef>) =>
    Effect.gen(function* () {
      const last = row.lastExecution

      const latest =
        last === null || last.endedAt === null
          ? null
          : {
              execution: last.id,
              outcome: last.outcome,
              sent: yield* inboxStore.sentIn(row.id, last.id),
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
        waiting: row.openExecution !== null || (yield* inboxStore.waitingOn(row.id)),
        latest,
      }
    })

  const machineMap = () =>
    remoteStore.machines.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.remoteId, row.name]))))

  return {
    list: () =>
      Effect.gen(function* () {
        const rows = yield* sessionStore.listSessions()
        const edges = yield* sessionStore.sessionEdges(rows.map((row) => row.id))
        const machineByRemote = yield* machineMap()

        return yield* Effect.forEach(rows, (row) =>
          summary(row, resolveEdgeRefs(edges.get(row.id) ?? [], machineByRemote)),
        )
      }),
    get: (id: string) =>
      Effect.gen(function* () {
        const row = yield* sessionStore.getSession(id)

        if (row === undefined) return undefined
        const edges = yield* sessionStore.sessionEdges([row.id])
        const machineByRemote = yield* machineMap()

        return yield* summary(row, resolveEdgeRefs(edges.get(row.id) ?? [], machineByRemote))
      }),
    sentIn: inboxStore.sentIn,
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Summaries") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [SessionStore.node, InboxStore.node, RemoteStore.node],
})
