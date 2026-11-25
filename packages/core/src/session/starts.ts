import { ProcessEvent } from "@vibest/schema/process-event"
import { SessionEvent } from "@vibest/schema/session-event"
import { Context, Effect, Layer, Semaphore, Stream } from "effect"

import { Bus } from "../bus.ts"
import { Concurrency } from "../concurrency.ts"
import { archived, type ProcessStart } from "../database/db-rows.ts"
import { Db } from "../database/db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { Inbox } from "../inbox.ts"
import * as Reactor from "../reactor.ts"
import { Placement } from "./placement.ts"

export * as Starts from "./starts.ts"

export interface Waiting {
  readonly id: string
  readonly start: ProcessStart
  readonly launch: Effect.Effect<void>
}

export const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const placement = yield* Placement.Service
  const inbox = yield* Inbox.Service
  const concurrency = yield* Concurrency.Service
  const reactor = yield* Reactor.make
  const scope = yield* Effect.scope
  const lock = yield* Semaphore.make(1)
  const list: Array<Waiting> = []

  const maxForNew = Effect.map(concurrency.limit, (limit) => (list.length > 0 ? 0 : limit))

  const closeLeft = (id: string) =>
    Effect.gen(function* () {
      const session = yield* db.session.getSession(id)

      if (session !== undefined) yield* placement.closeLeftTerminal(session)
    })

  const admit = (id: string, start: ProcessStart) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const max = yield* maxForNew

        if (max === 0) return false
        yield* closeLeft(id)

        return yield* db.session.admitProcess(id, start, max)
      }),
    )

  const walk = lock.withPermits(1)(
    Effect.gen(function* () {
      while (list.length > 0) {
        const next = list[0]!
        const session = yield* db.session.getSession(next.id)

        if (session === undefined || archived(session)) {
          list.shift()
          continue
        }

        const failedClose = yield* closeLeft(next.id).pipe(
          Effect.as<string | undefined>(undefined),
          Effect.catchTag("RuntimeError", (error) => Effect.succeed(error.message)),
        )

        if (failedClose !== undefined) {
          list.shift()
          yield* db.session.startProcess(next.id, next.start)
          yield* db.session.endProcess(next.id, "launch_failed")
          const session = yield* db.session.getSession(next.id)
          const pending = session === undefined ? [] : yield* db.inbox.pendingInbox(next.id)

          if (session !== undefined && pending.length > 0) yield* inbox.undelivered(session, pending, failedClose)
          continue
        }

        if (!(yield* db.session.admitProcess(next.id, next.start, yield* concurrency.limit))) return
        list.shift()
        yield* Effect.forkIn(next.launch, scope)
      }
    }),
  )

  const wait = (waiting: Waiting) =>
    Effect.sync(() => {
      if (!list.some((queued) => queued.id === waiting.id)) list.push(waiting)
    }).pipe(Effect.andThen(walk))

  const remove = (id: string) =>
    lock.withPermits(1)(
      Effect.sync(() => {
        const at = list.findIndex((queued) => queued.id === id)

        if (at >= 0) list.splice(at, 1)

        return at >= 0
      }),
    )

  yield* reactor.on([ProcessEvent.Ended, SessionEvent.Archived], () => walk)
  yield* concurrency.limits.pipe(
    Stream.runForEach(() => walk),
    Effect.forkScoped,
  )

  return {
    maxForNew,
    admit,
    wait,
    remove,
    waiting: Effect.sync(() => list.map((queued) => queued.id)),
    choices: Effect.sync(() => new Map(list.map((queued) => [queued.id, queued.start]))),
    isWaiting: (id: string) => Effect.sync(() => list.some((queued) => queued.id === id)),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Starts") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Bus.node, Concurrency.node, Db.node, Inbox.node, Placement.node],
})
