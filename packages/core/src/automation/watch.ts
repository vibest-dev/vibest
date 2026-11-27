import type { Automation } from "@vibest/schema/automation"
import { Clock, Duration, Effect, FiberMap, Predicate, Result, Stream } from "effect"

import type { Mcp } from "../mcp.ts"
import { AutomationEventStream } from "./event.ts"
import type { ExecuteOptions } from "./execute.ts"
import { type AutomationRow, parseEventPosition, type SettlePatch, toInfo } from "./sql.ts"
import type { AutomationStore } from "./store.ts"

const WATCH_RECONNECT_DELAY = Duration.seconds(5)

export interface WatchDeps {
  readonly store: AutomationStore.Interface
  readonly mcp: Mcp.Interface
  readonly arm: (key: string, delay: Duration.Duration, effect: Effect.Effect<unknown, unknown>) => Effect.Effect<void>
  readonly cancel: (key: string) => Effect.Effect<void>
  readonly withRunLock: (id: Automation.ID) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly pauseWith: (
    row: AutomationRow,
    now: number,
    reason: string,
    extra?: Pick<SettlePatch, "failures" | "lastRunAt">,
  ) => Effect.Effect<void>
  readonly executeRow: (row: AutomationRow, now: number, options?: ExecuteOptions) => Effect.Effect<void>
}

export const createWatchManager = ({ store, mcp, arm, cancel, withRunLock, pauseWith, executeRow }: WatchDeps) =>
  Effect.gen(function* () {
    const watches = yield* FiberMap.make<Automation.ID>()

    const runWatch = (id: Automation.ID): Effect.Effect<void> =>
      Effect.gen(function* () {
        const row = yield* store.getRow(id)

        if (row === undefined || row.status !== "active") return
        const info = toInfo(row)

        if (info.trigger.type !== "event") return
        const trigger = info.trigger
        const now = yield* Clock.currentTimeMillis

        if (row.expiresAt !== null && now >= row.expiresAt) {
          yield* store.settle(row, {
            status: "done",
            lastOutcome: "expired",
            timeUpdated: now,
          })

          return
        }

        const eventPos = parseEventPosition(row.eventPosition)

        if (eventPos === null) {
          yield* pauseWith(row, now, "No authorized event watch", { lastRunAt: now })

          return
        }

        if (eventPos.cursor === null) {
          yield* pauseWith(row, now, "No replay cursor; recreate the watch to start from now", { lastRunAt: now })

          return
        }

        const resolved = yield* Effect.result(
          AutomationEventStream.resolve(mcp, trigger, row.directory, eventPos.cursor),
        )

        if (Result.isFailure(resolved)) {
          if (Predicate.isTagged(resolved.failure, "AutomationEventStreamInvalid")) {
            yield* pauseWith(row, now, resolved.failure.message, { lastRunAt: now })
          } else {
            yield* arm(`automation.watch.${id}`, WATCH_RECONNECT_DELAY, ensureWatch(id))
          }

          return
        }

        if (eventPos.cursor === undefined) {
          yield* store.settle(row, {
            eventPosition: { ...eventPos, cursor: null },
            timeUpdated: now,
          })
        }

        const streamOutcome = yield* resolved.success.pipe(
          Stream.takeWhileEffect((message) =>
            withRunLock(id)(
              Effect.gen(function* () {
                const current = yield* store.getRow(id)
                const at = yield* Clock.currentTimeMillis

                if (current === undefined || current.status !== "active") return false

                if (current.expiresAt !== null && at >= current.expiresAt) {
                  yield* store.settle(current, {
                    status: "done",
                    lastOutcome: "expired",
                    timeUpdated: at,
                  })

                  return false
                }

                const currentEventPos = parseEventPosition(current.eventPosition)

                if (message.type !== "event") {
                  yield* store.settle(current, {
                    eventPosition: {
                      ...eventPos,
                      ...currentEventPos,
                      cursor: message.cursor,
                    },
                    timeUpdated: at,
                  })

                  return true
                }

                if (currentEventPos?.id === message.eventId) return true

                yield* executeRow(current, at, { event: message })
                const after = yield* store.getRow(id)

                return after !== undefined && after.status === "active"
              }),
            ),
          ),
          Stream.runDrain,
          Effect.result,
        )

        if (Result.isFailure(streamOutcome)) {
          const at = yield* Clock.currentTimeMillis
          const current = yield* store.getRow(id)

          if (current === undefined || current.status !== "active") return

          if (Predicate.isTagged(streamOutcome.failure, "AutomationEventStreamInvalid")) {
            yield* pauseWith(current, at, streamOutcome.failure.message, { lastRunAt: at })
          } else if (parseEventPosition(current.eventPosition)?.cursor == null) {
            yield* pauseWith(current, at, "No replay cursor; recreate the watch to start from now", { lastRunAt: at })
          } else {
            yield* arm(`automation.watch.${id}`, WATCH_RECONNECT_DELAY, ensureWatch(id))
          }
        }
      })

    const ensureWatch = (id: Automation.ID): Effect.Effect<void> =>
      Effect.gen(function* () {
        const row = yield* store.getRow(id)

        if (row === undefined || row.status !== "active") {
          yield* FiberMap.remove(watches, id)
          yield* cancel(`automation.watch.${id}`)

          return
        }

        const info = toInfo(row)

        if (info.trigger.type !== "event") return
        yield* FiberMap.run(watches, id, runWatch(id), { onlyIfMissing: true })
      })

    const syncWatches = Effect.gen(function* () {
      const activeRows = yield* store.activeEvents()
      const wanted = new Set<Automation.ID>()

      for (const row of activeRows) {
        const info = toInfo(row)

        if (info.trigger.type === "event") {
          wanted.add(info.id)
        }
      }

      for (const [id] of watches) {
        if (!wanted.has(id)) {
          yield* FiberMap.remove(watches, id)
          yield* cancel(`automation.watch.${id}`)
        }
      }

      for (const id of wanted) {
        yield* FiberMap.run(watches, id, runWatch(id), { onlyIfMissing: true })
      }
    })

    const hasWatch = (id: Automation.ID) => FiberMap.has(watches, id)

    return { syncWatches, hasWatch }
  })
