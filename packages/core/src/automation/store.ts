import { Automation } from "@vibest/schema/automation"
import { AutomationEvent } from "@vibest/schema/automation-event"
import type { Event } from "@vibest/schema/event"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, Layer } from "effect"

import { Bus } from "../bus.ts"
import { Database } from "../database/database.ts"
import { Projectors } from "../reactor.ts"
import { automationSql, type AutomationRow, type ListFilter, toInfo } from "./sql.ts"

export * as AutomationStore from "./store.ts"

export const make = Effect.gen(function* () {
  const { sql } = yield* Database.Service
  const { publish, transaction: tx } = yield* Bus.Service
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

    create: Effect.fn("AutomationStore.create")((data: Event.Data<typeof AutomationEvent.Created>) =>
      tx(
        Effect.gen(function* () {
          yield* publish(AutomationEvent.Created, data)
          const row = yield* queries.get(data.automationId)

          return toInfo(row!)
        }),
      ).pipe(Effect.orDie),
    ),

    pause: Effect.fn("AutomationStore.pause")(
      (
        id: Automation.ID,
        details?: {
          readonly reason?: string | undefined
          readonly lastOutcome?: Automation.Outcome | undefined
          readonly lastRunAt?: number | undefined
          readonly failures?: number | undefined
        },
      ) =>
        tx(
          Effect.gen(function* () {
            yield* requireRow(id)
            yield* publish(AutomationEvent.Paused, {
              automationId: id,
              ...(details?.reason !== undefined && { reason: details.reason }),
              ...(details?.lastOutcome !== undefined && { lastOutcome: details.lastOutcome }),
              ...(details?.lastRunAt !== undefined && { lastRunAt: details.lastRunAt }),
              ...(details?.failures !== undefined && { failures: details.failures }),
            })

            const row = yield* queries.get(id)

            return toInfo(row!)
          }),
        ).pipe(Effect.catchTag("SqlError", (e) => Effect.die(e))),
    ),

    resume: Effect.fn("AutomationStore.resume")((id: Automation.ID, nextDueAt?: number) =>
      tx(
        Effect.gen(function* () {
          yield* requireRow(id)
          yield* publish(AutomationEvent.Resumed, {
            automationId: id,
            ...(nextDueAt !== undefined && { nextDueAt }),
          })

          const row = yield* queries.get(id)

          return toInfo(row!)
        }),
      ).pipe(Effect.catchTag("SqlError", (e) => Effect.die(e))),
    ),

    remove: Effect.fn("AutomationStore.remove")((id: Automation.ID) =>
      tx(
        Effect.gen(function* () {
          yield* requireRow(id)
          yield* publish(AutomationEvent.Removed, { automationId: id })
        }),
      ).pipe(Effect.catchTag("SqlError", (e) => Effect.die(e))),
    ),

    recordTriggered: Effect.fn("AutomationStore.recordTriggered")(
      (data: Event.Data<typeof AutomationEvent.Triggered>) =>
        tx(
          Effect.gen(function* () {
            const existing = yield* queries.get(data.automationId)

            if (existing === undefined) return undefined
            yield* publish(AutomationEvent.Triggered, data)
            const row = yield* queries.get(data.automationId)

            return row === undefined ? undefined : toInfo(row)
          }),
        ).pipe(Effect.orDie),
    ),

    saveCursor: Effect.fn("AutomationStore.saveCursor")(
      (id: Automation.ID, cursor: string | null, lastEventId?: string) =>
        tx(
          Effect.gen(function* () {
            const existing = yield* queries.get(id)

            if (existing === undefined) return
            yield* publish(AutomationEvent.CursorSaved, {
              automationId: id,
              cursor,
              ...(lastEventId !== undefined && { lastEventId }),
            })
          }),
        ).pipe(Effect.orDie),
    ),

    nextDue: Effect.fn("AutomationStore.nextDue")(() => queries.nextDue().pipe(Effect.orDie)),

    dueAt: Effect.fn("AutomationStore.dueAt")((now: number) => queries.dueAt(now).pipe(Effect.orDie)),

    activeEvents: Effect.fn("AutomationStore.activeEvents")(() => queries.activeEvents().pipe(Effect.orDie)),

    hasDedupKey: Effect.fn("AutomationStore.hasDedupKey")((automationId: string, dedupKey: string) =>
      queries.hasDedupKey(automationId, dedupKey).pipe(Effect.orDie),
    ),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/AutomationStore") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Bus.node, Projectors.node],
})
