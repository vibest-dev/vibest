import type { Automation } from "@vibest/schema/automation"
import { Clock, Duration, Effect, FiberMap, Predicate, Result, Semaphore, Stream } from "effect"

import type { Mcp } from "../mcp.ts"
import { AutomationEventStream } from "./event.ts"
import type { ExecuteOptions } from "./execute.ts"
import { type AutomationRow, toInfo } from "./sql.ts"
import type { AutomationStore } from "./store.ts"

const WATCH_RECONNECT_DELAY = Duration.seconds(5)

export interface WatchDeps {
  readonly store: AutomationStore.Interface
  readonly mcp: Mcp.Interface
  readonly arm: (key: string, delay: Duration.Duration, effect: Effect.Effect<unknown, unknown>) => Effect.Effect<void>
  readonly cancel: (key: string) => Effect.Effect<void>
  readonly pauseQuiet: (
    id: Automation.ID,
    details?: {
      readonly reason?: string | undefined
      readonly lastOutcome?: Automation.Outcome | undefined
      readonly lastRunAt?: number | undefined
      readonly failures?: number | undefined
    },
  ) => Effect.Effect<void>
  readonly executeRow: (row: AutomationRow, now: number, options?: ExecuteOptions) => Effect.Effect<void>
}

export const createWatchManager = ({ store, mcp, arm, cancel, pauseQuiet, executeRow }: WatchDeps) =>
  Effect.gen(function* () {
    const watches = yield* FiberMap.make<Automation.ID>()

    const runWatch = (id: Automation.ID): Effect.Effect<void> =>
      Effect.gen(function* () {
        const delivery = yield* Semaphore.make(1)
        const row = yield* store.getRow(id)

        if (row === undefined || row.status !== "active") return
        const info = toInfo(row)

        if (info.trigger.type !== "event") return
        const trigger = info.trigger
        const now = yield* Clock.currentTimeMillis

        if (info.expiresAt !== undefined && now >= info.expiresAt) {
          yield* store.recordTriggered({
            automationId: id,
            status: "done",
            runCount: info.runCount,
            failures: info.failures,
            lastOutcome: "expired",
          })

          return
        }

        const savedCursor = row.hasCursor === 1 ? row.eventCursor : undefined

        if (row.hasCursor === 1 && savedCursor === null) {
          yield* pauseQuiet(id, {
            reason: "No replay cursor; recreate the watch to start from now",
            lastOutcome: "failed",
            lastRunAt: now,
          })

          return
        }

        const resolved = yield* Effect.result(AutomationEventStream.resolve(mcp, trigger, row.directory, savedCursor))

        if (Result.isFailure(resolved)) {
          if (Predicate.isTagged(resolved.failure, "AutomationEventStreamInvalid")) {
            yield* pauseQuiet(id, {
              reason: resolved.failure.message,
              lastOutcome: "failed",
              lastRunAt: now,
            })
          } else {
            yield* arm(`automation.watch.${id}`, WATCH_RECONNECT_DELAY, ensureWatch(id))
          }

          return
        }

        if (row.hasCursor === 0) {
          yield* store.saveCursor(id, null)
        }

        const streamOutcome = yield* resolved.success.pipe(
          Stream.takeWhileEffect((message) =>
            delivery.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* store.getRow(id)
                const at = yield* Clock.currentTimeMillis

                if (current === undefined || current.status !== "active") return false

                if (current.expiresAt !== null && at >= current.expiresAt) {
                  yield* store.recordTriggered({
                    automationId: id,
                    status: "done",
                    runCount: current.runCount,
                    failures: current.failures,
                    lastOutcome: "expired",
                  })

                  return false
                }

                if (message.type === "error") return true

                if (message.type !== "event") {
                  yield* store.saveCursor(id, message.cursor)

                  return true
                }

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

          if (Predicate.isTagged(streamOutcome.failure, "AutomationEventStreamInvalid")) {
            yield* pauseQuiet(id, {
              reason: streamOutcome.failure.message,
              lastOutcome: "failed",
              lastRunAt: at,
            })
          } else {
            const current = yield* store.getRow(id)

            if (current !== undefined && current.status === "active") {
              yield* arm(`automation.watch.${id}`, WATCH_RECONNECT_DELAY, ensureWatch(id))
            }
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
