import { Automation } from "@vibest/schema/automation"
import { KeyedMutex } from "@vibest/util/keyed-mutex"
import { LayerNode } from "@vibest/util/layer-node"
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  FiberMap,
  FiberSet,
  Layer,
  Option,
  Path,
  Ref,
  Result,
  Semaphore,
} from "effect"

import { CodeMode } from "../codemode.ts"
import { PlatformNode } from "../effect/platform.ts"
import { Mcp } from "../mcp.ts"
import { ProjectStore } from "../project/store.ts"
import { logFailure } from "../reactor.ts"
import { Session } from "../session.ts"
import { AutomationCode } from "./code.ts"
import { AutomationEventStream } from "./event.ts"
import { FAILED_RETRY, LATE_AFTER, createExecutor } from "./execute.ts"
import {
  computeInitialDue,
  computeResumeDue,
  followingSlot,
  freezeAtTrigger,
  isExpired,
  isFinished,
  nextCron,
  parseTime,
  resolveZone,
} from "./schedule.ts"
import { type ListFilter, toInfo } from "./sql.ts"
import { AutomationStore } from "./store.ts"
import { createWatchManager } from "./watch.ts"

export * as AutomationService from "./service.ts"

export { followingSlot, nextCron, parseTime }

const TICK_CONCURRENCY = 4
const TIMER_KEY = "automation.next"

export interface Interface {
  readonly create: (input: Automation.CreateInput) => Effect.Effect<Automation.Info, Automation.InvalidError>
  readonly list: (filter?: ListFilter) => Effect.Effect<ReadonlyArray<Automation.Info>>
  readonly get: (id: string) => Effect.Effect<Automation.Info, Automation.NotFoundError>
  readonly pause: (id: string) => Effect.Effect<Automation.Info, Automation.NotFoundError>
  readonly resume: (id: string) => Effect.Effect<Automation.Info, Automation.NotFoundError | Automation.InvalidError>
  readonly remove: (id: string) => Effect.Effect<void, Automation.NotFoundError>
  readonly tick: Effect.Effect<void>
  readonly runNow: (id: string) => Effect.Effect<Automation.Info, Automation.NotFoundError | Automation.InvalidError>
}

export class Service extends Context.Service<Service, Interface>()("vibest/Automation") {}

export const make = Effect.gen(function* () {
  const store = yield* AutomationStore.Service
  const codemode = yield* CodeMode.Service
  const mcp = yield* Mcp.Service
  const sessions = yield* Session.Service
  const projectStore = yield* ProjectStore.Service
  const path = yield* Path.Path
  const timers = yield* FiberMap.make<string>()
  const handlers = yield* FiberSet.make()
  const armLock = yield* Semaphore.make(1)
  const tickLock = yield* Semaphore.make(1)
  const tickRunning = yield* Ref.make(false)
  const runLocks = yield* KeyedMutex.make<Automation.ID>()

  const arm = (key: string, delay: Duration.Duration, effect: Effect.Effect<unknown, unknown>): Effect.Effect<void> =>
    FiberMap.run(
      timers,
      key,
      Effect.sleep(delay).pipe(Effect.andThen(FiberSet.run(handlers, logFailure(key)(effect)))),
    ).pipe(Effect.asVoid)

  const cancel = (key: string): Effect.Effect<void> => FiberMap.remove(timers, key)

  const { pauseWith, executeRow } = createExecutor({ store, codemode, sessions })

  const { syncWatches, hasWatch } = yield* createWatchManager({
    store,
    mcp,
    arm,
    cancel,
    withRunLock: runLocks.withLock,
    pauseWith,
    executeRow,
  })

  const resolveProjectId = (directory: string, explicitProjectId?: string): Effect.Effect<string> =>
    explicitProjectId !== undefined
      ? Effect.succeed(explicitProjectId)
      : projectStore.projectAt(directory).pipe(Effect.map((found) => found?.id ?? directory))

  const tickCore = Effect.fn("Automation.tick")(function* () {
    const from = yield* Clock.currentTimeMillis
    const due = yield* store.dueAt(from)

    yield* Effect.forEach(
      due,
      Effect.fnUntraced(function* (initial) {
        yield* runLocks.withLock(Automation.ID.make(initial.id))(
          Effect.gen(function* () {
            const row = yield* store.getRow(initial.id)

            if (row === undefined || row.status !== "active" || row.nextDueAt === null || row.nextDueAt > from) return

            if (row.retryAt !== null && row.retryAt > from) return
            const now = yield* Clock.currentTimeMillis

            if (isExpired(row.expiresAt, now) && now - row.nextDueAt >= LATE_AFTER) {
              yield* store.settle(row, {
                status: "done",
                nextDueAt: null,
                retryAt: null,
                lastOutcome: "expired",
                timeUpdated: now,
              })

              return
            }

            yield* executeRow(row, now).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
                const error = Cause.squash(cause)

                return Effect.logWarning("automation failed to run", { automationId: row.id, cause }).pipe(
                  Effect.andThen(
                    store.settle(row, {
                      failures: row.failures + 1,
                      retryAt: now + FAILED_RETRY,
                      lastRunAt: now,
                      lastOutcome: "failed",
                      lastOutput: error instanceof Error ? error.message : String(error),
                      timeUpdated: now,
                    }),
                  ),
                )
              }),
            )
          }),
        )
      }),
      { discard: true, concurrency: due.length > 1 ? TICK_CONCURRENCY : 1 },
    )
  })()

  const armNext: Effect.Effect<void> = armLock.withPermits(1)(
    Effect.gen(function* () {
      if (yield* Ref.get(tickRunning)) return
      const nextDueAt = yield* store.nextDue()

      if (nextDueAt === undefined) {
        yield* cancel(TIMER_KEY)

        return
      }

      const now = yield* Clock.currentTimeMillis
      const delay = Math.max(0, nextDueAt - now)
      yield* arm(TIMER_KEY, Duration.millis(delay), tick)
    }),
  )

  const tick: Effect.Effect<void> = tickLock.withPermits(1)(
    Ref.set(tickRunning, true).pipe(
      Effect.andThen(tickCore),
      Effect.ensuring(Ref.set(tickRunning, false).pipe(Effect.andThen(armNext))),
    ),
  )

  yield* Effect.forkScoped(Effect.all([armNext, syncWatches], { discard: true }))

  const create = Effect.fn("Automation.create")(function* (
    input: Automation.CreateInput,
  ): Effect.fn.Return<Automation.Info, Automation.InvalidError> {
    const now = yield* Clock.currentTimeMillis
    const tzInput = "tz" in input.trigger ? input.trigger.tz : undefined
    const zone = yield* resolveZone(tzInput)
    const tz = DateTime.zoneToString(zone)

    let expiresAt: number | null = null

    if (input.expires !== undefined) {
      const parsed = parseTime(input.expires, zone, now)

      if (Option.isNone(parsed)) {
        return yield* new Automation.InvalidError({ message: `Invalid expires time: ${input.expires}` })
      }

      if (parsed.value <= now) {
        return yield* new Automation.InvalidError({ message: "Expires time must be in the future" })
      }

      expiresAt = parsed.value
    }

    if (input.action.type === "code") {
      const valid = AutomationCode.validateCode(codemode, input.action.code)

      if (Result.isFailure(valid)) {
        return yield* new Automation.InvalidError({ message: valid.failure })
      }
    }

    if (input.action.type === "prompt" && input.action.to === undefined && input.sessionId === undefined) {
      return yield* new Automation.InvalidError({
        message: "Prompt action requires action.to ({ sessionId } or { agent }) or a creating sessionId",
      })
    }

    const directory = input.directory ?? path.resolve(".")

    if (input.trigger.type === "event") {
      yield* AutomationEventStream.validateEventTrigger(mcp, input.trigger, directory).pipe(
        Effect.mapError((error) => new Automation.InvalidError({ message: error.message })),
      )
    }

    const nextDueAt = yield* computeInitialDue(input.trigger, zone, tz, now)

    if (nextDueAt !== undefined && expiresAt !== null && nextDueAt > expiresAt) {
      return yield* new Automation.InvalidError({ message: "First trigger time is after expires time" })
    }

    const normalizedTrigger = freezeAtTrigger(input.trigger, nextDueAt)
    const projectId = yield* resolveProjectId(directory, input.projectId)
    const automationId = Automation.createId(now)

    const created = yield* store.create({
      id: automationId,
      projectId,
      sessionId: input.sessionId ?? null,
      directory,
      name: input.name,
      trigger: normalizedTrigger,
      tz,
      action: input.action,
      nextDueAt: nextDueAt ?? null,
      expiresAt,
      eventPosition: normalizedTrigger.type === "event" ? {} : null,
      timeCreated: now,
      timeUpdated: now,
    })

    if (normalizedTrigger.type === "event") {
      yield* syncWatches
    } else {
      yield* armNext
    }

    return created
  })

  const list = Effect.fn("Automation.list")((filter?: ListFilter) => store.list(filter))

  const get = Effect.fn("Automation.get")((id: string) => store.get(id))

  const pause = Effect.fn("Automation.pause")(function* (id: string) {
    const now = yield* Clock.currentTimeMillis
    const paused = yield* store.pause(id, now)
    yield* armNext
    yield* cancel(`automation.watch.${paused.id}`)

    if (paused.trigger.type === "event" || (yield* hasWatch(paused.id))) {
      yield* syncWatches
    }

    return paused
  })

  const resume = Effect.fn("Automation.resume")(function* (
    id: string,
  ): Effect.fn.Return<Automation.Info, Automation.NotFoundError | Automation.InvalidError> {
    const row = yield* store.requireRow(id)
    const info = toInfo(row)

    if (info.status === "done") {
      return yield* new Automation.InvalidError({ message: `Automation ${id} is already done` })
    }

    if (info.status !== "paused") return info

    const now = yield* Clock.currentTimeMillis
    const next = computeResumeDue(info.trigger, info.tz, row.nextDueAt, now)

    const done =
      (info.trigger.type !== "event" && (next === null || isFinished(row.expiresAt, next))) ||
      isExpired(row.expiresAt, now)

    const resumed = yield* store.resume(info.id, {
      status: done ? "done" : "active",
      nextDueAt: done ? null : next,
      timeUpdated: now,
    })

    yield* armNext

    if (resumed.trigger.type === "event") {
      yield* syncWatches
    }

    return resumed
  })

  const remove = Effect.fn("Automation.remove")(function* (id: string) {
    const info = yield* store.get(id)
    yield* store.remove(info.id)
    yield* armNext
    yield* cancel(`automation.watch.${info.id}`)

    if (info.trigger.type === "event" || (yield* hasWatch(info.id))) {
      yield* syncWatches
    }
  })

  const runNow = Effect.fn("Automation.runNow")(function* (
    id: string,
  ): Effect.fn.Return<Automation.Info, Automation.NotFoundError | Automation.InvalidError> {
    const initial = yield* store.requireRow(id)

    yield* runLocks.withLock(Automation.ID.make(initial.id))(
      Effect.gen(function* () {
        const row = yield* store.requireRow(id)

        if (row.status === "done") {
          return yield* new Automation.InvalidError({ message: `Automation ${id} is already done` })
        }

        const now = yield* Clock.currentTimeMillis
        yield* executeRow(row, now, { manual: true })
      }),
    )

    yield* armNext
    const updated = yield* store.get(id)

    if (yield* hasWatch(updated.id)) {
      yield* syncWatches
    }

    return updated
  })

  return Service.of({
    create,
    list,
    get,
    pause,
    resume,
    remove,
    tick,
    runNow,
  })
})

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [AutomationStore.node, CodeMode.node, Mcp.node, Session.node, ProjectStore.node, PlatformNode.path],
})
