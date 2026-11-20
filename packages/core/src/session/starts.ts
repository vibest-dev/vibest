import { ProcessEnded, SessionEnded } from "@vibest/schema/event"
import { Context, Data, Deferred, Effect, Layer, Semaphore, Stream } from "effect"

import { Bus } from "../bus.ts"
import { Concurrency } from "../concurrency.ts"
import { Db } from "../database/db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import * as Reactor from "../reactor.ts"

export * as Starts from "./starts.ts"

export class StartCancelled extends Data.TaggedError("StartCancelled")<{ readonly key: string }> {}

interface Waiting {
  readonly key: string
  readonly replaces: ReadonlyArray<string>
  readonly admit: Deferred.Deferred<boolean>
}

export const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const concurrency = yield* Concurrency.Service
  const reactor = yield* Reactor.make
  const lock = yield* Semaphore.make(1)
  const starting = new Set<string>()
  const queue: Array<Waiting> = []

  const room = (replaces: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const limit = yield* concurrency.limit

      if (limit === undefined) return true
      const live = (yield* db.session.liveProcesses()).filter((id) => !replaces.includes(id))

      return new Set([...live, ...starting]).size < limit
    })

  const admitWaiting = lock.withPermits(1)(
    Effect.gen(function* () {
      while (queue.length > 0 && (yield* room(queue[0]!.replaces))) {
        const next = queue.shift()!
        starting.add(next.key)
        yield* Deferred.succeed(next.admit, true)
      }
    }),
  )

  const release = (key: string) => Effect.sync(() => starting.delete(key)).pipe(Effect.andThen(admitWaiting))

  const enter = (key: string, replaces: ReadonlyArray<string>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (queue.length === 0 && (yield* room(replaces))) {
          starting.add(key)

          return undefined
        }

        const waiting = { key, replaces, admit: yield* Deferred.make<boolean>() }
        queue.push(waiting)

        return waiting
      }),
    )

  const leave = (waiting: Waiting) =>
    lock
      .withPermits(1)(
        Effect.sync(() => {
          const at = queue.indexOf(waiting)

          if (at >= 0) queue.splice(at, 1)
        }),
      )
      .pipe(Effect.andThen(release(waiting.key)))

  const gate = <A, E, R>(key: string, replaces: ReadonlyArray<string>, start: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const waiting = yield* enter(key, replaces)

        if (waiting !== undefined) {
          const admitted = yield* Effect.interruptible(Deferred.await(waiting.admit)).pipe(
            Effect.onInterrupt(() => leave(waiting)),
          )

          if (!admitted) return yield* new StartCancelled({ key })
        }

        return yield* restore(start).pipe(Effect.ensuring(release(key)))
      }),
    )

  const cancel = (key: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const at = queue.findIndex((waiting) => waiting.key === key)

        if (at < 0) return
        const [waiting] = queue.splice(at, 1)
        yield* Deferred.succeed(waiting!.admit, false)
      }),
    )

  yield* reactor.on([ProcessEnded, SessionEnded], () => admitWaiting)
  yield* concurrency.limits.pipe(
    Stream.runForEach(() => admitWaiting),
    Effect.forkScoped,
  )

  return {
    gate,
    cancel,
    waiting: Effect.sync(() => queue.map((waiting) => waiting.key)),
    isWaiting: (key: string) => Effect.sync(() => queue.some((waiting) => waiting.key === key)),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Starts") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({ service: Service, layer, deps: [Bus.node, Concurrency.node, Db.node] })
