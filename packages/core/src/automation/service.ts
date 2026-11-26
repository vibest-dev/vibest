import { Automation } from "@vibest/schema/automation"
import { AutomationEvent } from "@vibest/schema/automation-event"
import { KeyedMutex } from "@vibest/util/keyed-mutex"
import { LayerNode } from "@vibest/util/layer-node"
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Path,
  Result,
  type Schema,
  Semaphore,
} from "effect"
import { Digest } from "effect/crypto"

import { Bus } from "../bus.ts"
import { CodeMode } from "../codemode.ts"
import { PlatformNode } from "../effect/platform.ts"
import { Mcp } from "../mcp.ts"
import { ProjectStore } from "../project/store.ts"
import * as Reactor from "../reactor.ts"
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
  nextCron,
  parseTime,
  readHeader,
  resolveZone,
  sha256Hex,
  verifyWebhookAuth,
} from "./schedule.ts"
import { AutomationSecretStore } from "./secret-store.ts"
import { type ListFilter, toInfo } from "./sql.ts"
import { AutomationStore } from "./store.ts"
import { createWatchManager } from "./watch.ts"

export * as AutomationService from "./service.ts"

export { followingSlot, nextCron, parseTime }

const TICK_CONCURRENCY = 4
const TIMER_KEY = "automation.timer"

export interface WebhookCallInput {
  readonly id: string
  readonly rawBody: string
  readonly payload: Schema.Json
  readonly headers: Readonly<Record<string, string>>
}

export interface Interface {
  readonly create: (input: Automation.CreateInput) => Effect.Effect<Automation.Info, Automation.InvalidError>
  readonly list: (filter?: ListFilter) => Effect.Effect<ReadonlyArray<Automation.Info>>
  readonly get: (id: string) => Effect.Effect<Automation.Info, Automation.NotFoundError>
  readonly pause: (id: string) => Effect.Effect<Automation.Info, Automation.NotFoundError>
  readonly resume: (id: string) => Effect.Effect<Automation.Info, Automation.NotFoundError | Automation.InvalidError>
  readonly remove: (id: string) => Effect.Effect<void, Automation.NotFoundError>
  readonly tick: Effect.Effect<void>
  readonly runNow: (id: string) => Effect.Effect<Automation.Info, Automation.NotFoundError | Automation.InvalidError>
  readonly webhook: (
    input: WebhookCallInput,
  ) => Effect.Effect<
    Automation.WebhookResult,
    Automation.NotFoundError | Automation.InvalidError | Automation.WebhookUnauthorizedError
  >
}

export class Service extends Context.Service<Service, Interface>()("vibest/Automation") {}

export const make = Effect.gen(function* () {
  const store = yield* AutomationStore.Service
  const secretStore = yield* AutomationSecretStore.Service
  const codemode = yield* CodeMode.Service
  const mcp = yield* Mcp.Service
  const sessions = yield* Session.Service
  const projectStore = yield* ProjectStore.Service
  const digest = yield* Digest.Digest
  const path = yield* Path.Path
  const reactor = yield* Reactor.make
  const armLock = yield* Semaphore.make(1)
  const webhookLocks = yield* KeyedMutex.make<string>()

  const { pauseQuiet, executeRow } = createExecutor({ store, codemode, sessions })

  const { syncWatches, hasWatch } = yield* createWatchManager({
    store,
    mcp,
    arm: reactor.arm,
    cancel: reactor.cancel,
    pauseQuiet,
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
        const row = yield* store.getRow(initial.id)

        if (row === undefined || row.status !== "active" || row.nextDueAt === null || row.nextDueAt > from) return

        if (row.retryAt !== null && row.retryAt > from) return
        const now = yield* Clock.currentTimeMillis

        if (isExpired(row.expiresAt, now) && now - row.nextDueAt >= LATE_AFTER) {
          yield* store.recordTriggered({
            automationId: Automation.ID.make(row.id),
            status: "done",
            runCount: row.runCount,
            failures: row.failures,
            nextDueAt: null,
            retryAt: null,
            lastOutcome: "expired",
          })

          return
        }

        yield* executeRow(row, now).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
            const error = Cause.squash(cause)

            return Effect.logWarning("automation failed to run", { automationId: row.id, cause }).pipe(
              Effect.andThen(
                store.recordTriggered({
                  automationId: Automation.ID.make(row.id),
                  status: "active",
                  runCount: row.runCount,
                  failures: row.failures + 1,
                  retryAt: now + FAILED_RETRY,
                  lastRunAt: now,
                  lastOutcome: "failed",
                  lastOutput: error instanceof Error ? error.message : String(error),
                }),
              ),
            )
          }),
        )
      }),
      { discard: true, concurrency: due.length > 1 ? TICK_CONCURRENCY : 1 },
    )
  })()

  const armNext: Effect.Effect<void> = armLock.withPermits(1)(
    Effect.gen(function* () {
      const nextDueAt = yield* store.nextDue()

      if (nextDueAt === undefined) {
        yield* reactor.cancel(TIMER_KEY)

        return
      }

      const now = yield* Clock.currentTimeMillis
      const delay = Math.max(0, nextDueAt - now)
      yield* reactor.arm(TIMER_KEY, Duration.millis(delay), tick)
    }),
  )

  const tick: Effect.Effect<void> = tickCore.pipe(Effect.ensuring(armNext))

  yield* reactor.on(
    [
      AutomationEvent.Created,
      AutomationEvent.Paused,
      AutomationEvent.Resumed,
      AutomationEvent.Removed,
      AutomationEvent.Triggered,
    ],
    (event) =>
      Effect.gen(function* () {
        yield* armNext

        if (event.type === "automation.created") {
          if (event.data.trigger.type === "event") yield* syncWatches

          return
        }

        if (event.type === "automation.removed" || event.type === "automation.paused") {
          if (yield* hasWatch(event.data.automationId)) yield* syncWatches

          return
        }

        if (event.type === "automation.resumed") {
          const row = yield* store.getRow(event.data.automationId)

          if (row !== undefined && toInfo(row).trigger.type === "event") yield* syncWatches

          return
        }

        if ((yield* hasWatch(event.data.automationId)) && event.data.status !== "active") {
          yield* syncWatches
        }
      }),
  )

  yield* Effect.forkScoped(Effect.all([armNext, syncWatches], { discard: true }))

  const create = Effect.fn("Automation.create")(function* (
    input: Automation.CreateInput,
  ): Effect.fn.Return<Automation.Info, Automation.InvalidError> {
    const now = yield* Clock.currentTimeMillis
    const tzInput = "tz" in input.trigger ? input.trigger.tz : undefined
    const zone = yield* resolveZone(tzInput)
    const tz = DateTime.zoneToString(zone)

    let expiresAt: number | undefined

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

    if (nextDueAt !== undefined && expiresAt !== undefined && nextDueAt > expiresAt) {
      return yield* new Automation.InvalidError({ message: "First trigger time is after expires time" })
    }

    const frozenTrigger = freezeAtTrigger(input.trigger, nextDueAt)

    const normalizedTrigger: Automation.Trigger =
      frozenTrigger.type === "webhook" && input.webhookSecret !== undefined
        ? { type: "webhook", secretHash: yield* sha256Hex(digest, input.webhookSecret) }
        : frozenTrigger

    const projectId = yield* resolveProjectId(directory, input.projectId)
    const automationId = Automation.createId(now)

    const created = yield* store.create({
      automationId,
      name: input.name,
      projectId,
      ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
      directory,
      trigger: normalizedTrigger,
      tz,
      action: input.action,
      ...(expiresAt !== undefined && { expiresAt }),
      ...(nextDueAt !== undefined && { nextDueAt }),
    })

    if (input.trigger.type === "webhook" && input.webhookSecret !== undefined) {
      yield* secretStore.set(automationId, input.webhookSecret)
    }

    return created
  })

  const list = Effect.fn("Automation.list")((filter?: ListFilter) => store.list(filter))

  const get = Effect.fn("Automation.get")((id: string) => store.get(id))

  const pause = Effect.fn("Automation.pause")(function* (id: string) {
    const info = yield* store.get(id)

    return yield* store.pause(info.id)
  })

  const resume = Effect.fn("Automation.resume")(function* (
    id: string,
  ): Effect.fn.Return<Automation.Info, Automation.NotFoundError | Automation.InvalidError> {
    const info = yield* store.get(id)

    if (info.status === "done") {
      return yield* new Automation.InvalidError({ message: `Automation ${id} is already done` })
    }

    const now = yield* Clock.currentTimeMillis
    const zone = yield* resolveZone(info.tz)
    const nextDueAt = yield* computeResumeDue(info.trigger, zone, info.tz, now)

    return yield* store.resume(info.id, nextDueAt)
  })

  const remove = Effect.fn("Automation.remove")(function* (id: string) {
    const info = yield* store.get(id)
    yield* store.remove(info.id)
    yield* secretStore.remove(info.id)
  })

  const runNow = Effect.fn("Automation.runNow")(function* (
    id: string,
  ): Effect.fn.Return<Automation.Info, Automation.NotFoundError | Automation.InvalidError> {
    const row = yield* store.getRow(id)

    if (row === undefined) {
      return yield* new Automation.NotFoundError({ automationId: id, message: `Automation not found: ${id}` })
    }

    const now = yield* Clock.currentTimeMillis
    yield* executeRow(row, now, { manual: true })

    return yield* store.get(id)
  })

  const webhook = Effect.fn("Automation.webhook")((input: WebhookCallInput) =>
    webhookLocks.withLock(input.id)(
      Effect.gen(function* () {
        const row = yield* store.getRow(input.id)

        if (row === undefined) {
          return yield* new Automation.NotFoundError({
            automationId: input.id,
            message: `Automation not found: ${input.id}`,
          })
        }

        const info = toInfo(row)

        if (info.trigger.type !== "webhook") {
          return yield* new Automation.InvalidError({ message: `Automation ${input.id} is not a webhook automation` })
        }

        const webhookSecret = yield* secretStore.get(info.id)
        yield* verifyWebhookAuth(digest, info.id, info.trigger, webhookSecret, input.headers, input.rawBody)

        if (info.status !== "active") {
          return {
            automationId: info.id,
            accepted: false,
            deduplicated: false,
            info,
          }
        }

        const idempotencyKey = readHeader(input.headers, "x-idempotency-key")?.trim() || undefined

        if (idempotencyKey !== undefined && (yield* store.hasDedupKey(info.id, idempotencyKey))) {
          return {
            automationId: info.id,
            accepted: true,
            deduplicated: true,
            info,
          }
        }

        const now = yield* Clock.currentTimeMillis

        yield* executeRow(row, now, {
          webhook: {
            payload: input.payload,
            headers: input.headers,
            ...(idempotencyKey !== undefined && { idempotencyKey }),
          },
          ...(idempotencyKey !== undefined && { dedupKey: idempotencyKey }),
        })

        const updated = yield* store.get(info.id)

        return {
          automationId: info.id,
          accepted: true,
          deduplicated: false,
          info: updated,
        }
      }),
    ),
  )

  return Service.of({
    create,
    list,
    get,
    pause,
    resume,
    remove,
    tick,
    runNow,
    webhook,
  })
})

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    AutomationStore.node,
    AutomationSecretStore.node,
    Bus.node,
    CodeMode.node,
    Mcp.node,
    Session.node,
    ProjectStore.node,
    PlatformNode.digest,
    PlatformNode.path,
  ],
})
