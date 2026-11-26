import { Automation } from "@vibest/schema/automation"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, Layer } from "effect"

import { Database } from "../database/database.ts"
import {
  automationSql,
  type AutomationRow,
  type InsertAutomationRow,
  type ListFilter,
  type ResumePatch,
  type SettleOptions,
  type SettlePatch,
  toInfo,
} from "./sql.ts"

export * as AutomationStore from "./store.ts"

export const make = Effect.gen(function* () {
  const { sql } = yield* Database.Service
  const queries = automationSql(sql)

  const getRow = Effect.fn("AutomationStore.getRow")((id: string) => queries.get(id).pipe(Effect.orDie))

  const requireRow = (id: string): Effect.Effect<AutomationRow, Automation.NotFoundError> =>
    getRow(id).pipe(
      Effect.flatMap((row) =>
        row !== undefined
          ? Effect.succeed(row)
          : Effect.fail(new Automation.NotFoundError({ automationId: id, message: `Automation not found: ${id}` })),
      ),
    )

  return {
    getRow,

    get: Effect.fn("AutomationStore.get")((id: string) => requireRow(id).pipe(Effect.map(toInfo))),

    list: Effect.fn("AutomationStore.list")((filter?: ListFilter) =>
      queries.list(filter).pipe(
        Effect.map((rows) => rows.map(toInfo)),
        Effect.orDie,
      ),
    ),

    create: Effect.fn("AutomationStore.create")(function* (row: InsertAutomationRow) {
      yield* queries.insert(row).pipe(Effect.orDie)
      const inserted = yield* getRow(row.id)

      return toInfo(inserted!)
    }),

    pause: Effect.fn("AutomationStore.pause")(function* (id: string, now: number) {
      const existing = yield* requireRow(id)

      if (existing.status !== "active") return toInfo(existing)
      yield* queries.pause(existing.id, now).pipe(Effect.orDie)

      return toInfo(yield* requireRow(existing.id))
    }),

    resume: Effect.fn("AutomationStore.resume")(function* (id: string, patch: ResumePatch) {
      const existing = yield* requireRow(id)

      if (existing.status !== "paused") return toInfo(existing)
      yield* queries.resume(existing.id, patch).pipe(Effect.orDie)

      return toInfo(yield* requireRow(existing.id))
    }),

    remove: Effect.fn("AutomationStore.remove")(function* (id: string) {
      const existing = yield* requireRow(id)
      yield* queries.remove(existing.id).pipe(Effect.orDie)
    }),

    settle: Effect.fn("AutomationStore.settle")(
      (row: Pick<AutomationRow, "id" | "runCount">, patch: SettlePatch, options?: SettleOptions) =>
        queries.settle(row, patch, options).pipe(Effect.orDie),
    ),

    nextDue: Effect.fn("AutomationStore.nextDue")(() => queries.nextDue().pipe(Effect.orDie)),

    dueAt: Effect.fn("AutomationStore.dueAt")((now: number) => queries.dueAt(now).pipe(Effect.orDie)),

    activeEvents: Effect.fn("AutomationStore.activeEvents")(() => queries.activeEvents().pipe(Effect.orDie)),

    hasPendingInboxMessage: Effect.fn("AutomationStore.hasPendingInboxMessage")(
      (sessionId: string, requestId: string) => queries.hasPendingInboxMessage(sessionId, requestId).pipe(Effect.orDie),
    ),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/AutomationStore") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node],
})
