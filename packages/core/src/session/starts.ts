import { ProcessEnded, SessionEnded } from "@vibest/schema/event"
import { Context, Deferred, Effect, Layer, Semaphore, Stream } from "effect"

import { Bus } from "../bus.ts"
import { Concurrency } from "../concurrency.ts"
import { Db } from "../database/db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import * as Reactor from "../reactor.ts"

export * as Starts from "./starts.ts"

interface Waiting {
  readonly key: string
  readonly admit: Deferred.Deferred<void>
}

export const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const concurrency = yield* Concurrency.Service
  const reactor = yield* Reactor.make
  const scope = yield* Effect.scope
  const lock = yield* Semaphore.make(1)
  const starting: Array<string> = []
  const queue: Array<Waiting> = []
  let unnamed = 0

  const room = Effect.gen(function* () {
    const limit = yield* concurrency.limit

    if (limit === undefined) return true

    return new Set([...(yield* db.session.liveProcesses()), ...starting]).size < limit
  })

  const admitWaiting = lock.withPermits(1)(
    Effect.gen(function* () {
      while (queue.length > 0 && (yield* room)) {
        const next = queue.shift()!
        starting.push(next.key)
        yield* Deferred.succeed(next.admit, undefined)
      }
    }),
  )

  const release = (key: string) =>
    Effect.sync(() => {
      const at = starting.indexOf(key)

      if (at >= 0) starting.splice(at, 1)
    }).pipe(Effect.andThen(admitWaiting))

  const enter = (key: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (starting.includes(key)) return "joined" as const

        if (queue.length === 0 && (yield* room)) {
          starting.push(key)

          return "admitted" as const
        }

        const waiting = { key, admit: yield* Deferred.make<void>() }
        queue.push(waiting)

        return waiting
      }),
    )

  const leave = (waiting: Waiting) =>
    Effect.sync(() => {
      const at = queue.indexOf(waiting)

      if (at >= 0) queue.splice(at, 1)
    })

  const run = <A, E, R>(
    key: string | undefined,
    start: Effect.Effect<A, E, R>,
    onWait: Effect.Effect<void> = Effect.void,
  ) =>
    Effect.suspend(() => {
      const named = key ?? `start ${++unnamed}`

      return Effect.flatMap(enter(named), (entered) =>
        entered === "joined" || entered === "admitted"
          ? start
          : onWait.pipe(
              Effect.andThen(Deferred.await(entered.admit)),
              Effect.onInterrupt(() => leave(entered)),
              Effect.andThen(start),
            ),
      ).pipe(Effect.ensuring(release(named)))
    })

  const startOrQueue = <E>(key: string, now: Effect.Effect<void, E>, later: Effect.Effect<void>) =>
    Effect.flatMap(enter(key), (entered) => {
      if (entered === "joined") return now

      if (entered === "admitted") return now.pipe(Effect.ensuring(release(key)))

      return Effect.asVoid(
        Effect.forkIn(Deferred.await(entered.admit).pipe(Effect.andThen(later), Effect.ensuring(release(key))), scope),
      )
    })

  yield* reactor.on([ProcessEnded, SessionEnded], () => admitWaiting)
  yield* concurrency.limits.pipe(
    Stream.runForEach(() => admitWaiting),
    Effect.forkScoped,
  )

  return {
    run,
    startOrQueue,
    waiting: Effect.sync(() => queue.map((waiting) => waiting.key)),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Starts") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({ service: Service, layer, deps: [Bus.node, Concurrency.node, Db.node] })
