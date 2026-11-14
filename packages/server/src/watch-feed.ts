import { Bus } from "@vibest/core/bus"
import { WatchLagged, type WatchEvent } from "@vibest/protocol/rpc"
import { Cause, Context, Effect, Layer, PubSub, Queue, type Scope, Stream } from "effect"

import * as Listing from "./listing.ts"

export * as WatchFeed from "./watch-feed.ts"

export const WATCH_BACKLOG = 10_000

const watched = [
  { type: "session.changed" },
  { type: "project.changed" },
  { type: "terminal.state" },
  { type: "terminal.exited" },
  { type: "terminal.seen" },
  { type: "runtime.reset" },
] as const

export interface Interface {
  readonly subscribe: Effect.Effect<Stream.Stream<WatchEvent, WatchLagged>, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("vibest/WatchFeed") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus
    const listing = yield* Listing.Service
    const watchers = new Set<Queue.Queue<WatchEvent, WatchLagged>>()

    const publish = (event: WatchEvent) =>
      Effect.sync(() => {
        for (const watcher of watchers) {
          if (Queue.offerUnsafe(watcher, event)) continue
          watchers.delete(watcher)
          Queue.failCauseUnsafe(
            watcher,
            Cause.fail(
              new WatchLagged({
                message: `Watch fell ${WATCH_BACKLOG} events behind; reconnect for a new Snapshot`,
              }),
            ),
          )
        }
      })

    const subscription = yield* bus.subscribe(watched)
    yield* Stream.fromEffectRepeat(PubSub.takeAll(subscription)).pipe(
      Stream.mapEffect(listing.watchDeltas),
      Stream.runForEach(Effect.forEach(publish, { discard: true })),
      Effect.forkScoped,
    )

    return Service.of({
      subscribe: Effect.acquireRelease(
        Queue.dropping<WatchEvent, WatchLagged>(WATCH_BACKLOG).pipe(
          Effect.tap((queue) => Effect.sync(() => watchers.add(queue))),
        ),
        (queue) => Effect.sync(() => watchers.delete(queue)).pipe(Effect.andThen(Queue.shutdown(queue))),
      ).pipe(Effect.map(Stream.fromQueue)),
    })
  }),
)
