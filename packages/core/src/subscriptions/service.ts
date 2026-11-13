import type { SubscriptionReport } from "@vibest/plugin/effect"
import { type Subscription, type SubscriptionLimit } from "@vibest/schema/subscription"
import { Clock, Config, Context, Duration, Effect, Fiber, Layer, Option, Ref, Semaphore } from "effect"

import { LayerNode } from "../effect/layer-node.ts"
import { Harness, type HarnessId, Harnesses } from "../harness.ts"
import type { HarnessDefinition, SubscriptionsShape } from "../host.ts"
import { logFailure } from "../reactor.ts"

const MINUTE = "1 minute"
const CLI_TIMEOUT = "10 seconds"
const SUBSCRIPTION_TIMEOUT = "30 seconds"
const MACHINE = "local" as const

type Row = Subscription
type Usage = { readonly limits: ReadonlyArray<SubscriptionLimit>; readonly error?: string } | { readonly error: string }

const keyOf = (harness: string, provider: string) => `${harness}\0${provider}`

const isLimit = (limit: SubscriptionLimit) =>
  typeof limit?.window === "string" &&
  limit.window !== "" &&
  typeof limit.percent === "number" &&
  Number.isFinite(limit.percent) &&
  (limit.status === "available" || limit.status === "limited") &&
  (limit.resetTime === null || (typeof limit.resetTime === "number" && Number.isFinite(limit.resetTime)))

const homeDir = Config.String("HOME").pipe(Config.withDefault(""), Effect.orDie)

const keep = (prev: Row | undefined, now: number, error: string, harness: HarnessId, provider: string): Row =>
  prev
    ? { ...prev, error }
    : { harness, provider, machine: MACHINE, account: { kind: "none" }, limits: [], updatedAt: now, error }

const wrote = (
  prev: Row | undefined,
  now: number,
  harness: HarnessId,
  provider: string,
  account: Subscription["account"],
  usage?: Usage,
): Row => {
  const limits = usage && "limits" in usage ? usage.limits : (prev?.limits ?? [])
  const error = usage && "error" in usage ? usage.error : undefined
  return { harness, provider, machine: MACHINE, account, limits, updatedAt: now, ...(error ? { error } : {}) }
}

export class Subscriptions extends Context.Service<Subscriptions, SubscriptionsShape>()("vibest/Subscriptions") {
  static readonly make = Effect.gen(function* () {
    const harnesses = yield* Harnesses
    const harness = yield* Harness
    const rows = yield* Ref.make(new Map<string, Row>())
    const modify = (harness: HarnessId, provider: string, f: (prev: Row | undefined, now: number) => Row) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* Ref.update(rows, (map) => {
          const next = new Map(map)
          next.set(keyOf(harness, provider), f(map.get(keyOf(harness, provider)), now))
          return next
        })
      })

    const list = Ref.get(rows).pipe(
      Effect.map((map) =>
        [...map.values()].sort((a, b) => a.harness.localeCompare(b.harness) || a.provider.localeCompare(b.provider)),
      ),
    )

    const report = Effect.fn("Subscriptions.report")(function* (input: SubscriptionReport) {
      const harness = input.harness
      if (harnesses.find(harness) === undefined || !Array.isArray(input.limits) || !input.limits.every(isLimit)) {
        yield* Effect.logWarning(`subscription report ignored for ${JSON.stringify(input.harness)}`)
        return
      }
      const provider = input.provider ?? ""
      yield* modify(harness, provider, (prev, now) => ({
        harness,
        provider,
        machine: MACHINE,
        account: prev?.account ?? { kind: "none" },
        limits: input.limits,
        updatedAt: now,
      }))
    })

    const read = (definition: HarnessDefinition, home: string) =>
      Effect.gen(function* () {
        const id = definition.id
        const read = yield* definition.subscription!(home).pipe(Effect.timeoutOption(SUBSCRIPTION_TIMEOUT))
        if (Option.isNone(read))
          return yield* Effect.logWarning(`subscriptions: ${id} poll timed out after ${SUBSCRIPTION_TIMEOUT}`)
        for (const row of read.value)
          yield* modify(id, row.provider, (prev, now) =>
            row.account === undefined
              ? keep(prev, now, row.error ?? "subscription read failed", id, row.provider)
              : wrote(
                  prev,
                  now,
                  id,
                  row.provider,
                  row.account,
                  row.limits !== undefined
                    ? { limits: row.limits, ...(row.error ? { error: row.error } : {}) }
                    : row.error
                      ? { error: row.error }
                      : undefined,
                ),
          )
      }).pipe(logFailure(`subscriptions: ${definition.id} poll failed`))
    const poll = Effect.gen(function* () {
      const home = yield* homeDir
      for (const definition of harnesses.all)
        if (definition.subscription && (yield* harness.available(definition.id))) yield* read(definition, home)
    })

    return Subscriptions.of({ list, report, poll })
  })

  static readonly testLayer = Layer.effect(Subscriptions, Subscriptions.make)

  static readonly layer = Layer.effect(
    Subscriptions,
    Effect.gen(function* () {
      const service = yield* Subscriptions.make
      const harnesses = yield* Harnesses
      const scope = yield* Effect.scope
      const lock = yield* Semaphore.make(1)
      let polledAt = Number.NEGATIVE_INFINITY
      let running: Fiber.Fiber<void> | undefined
      const refresh = lock.withPermit(
        Effect.gen(function* () {
          if (running !== undefined && running.pollUnsafe() === undefined) return running
          const now = yield* Clock.currentTimeMillis
          if (now - polledAt < Duration.toMillis(MINUTE) || harnesses.all.length === 0) return undefined
          polledAt = now
          running = yield* Effect.forkIn(service.poll, scope)
          return running
        }),
      )
      yield* refresh
      return Subscriptions.of({
        ...service,
        list: refresh.pipe(
          Effect.flatMap((fiber) => (fiber === undefined ? Effect.void : Fiber.await(fiber))),
          Effect.timeoutOption(CLI_TIMEOUT),
          Effect.andThen(service.list),
        ),
      })
    }),
  )

  static readonly node = LayerNode.make({
    service: Subscriptions,
    layer: Subscriptions.layer,
    deps: [Harness.node, Harnesses.node],
  })
}
