import {
  Bus,
  type BusEvent,
  ProjectChanged,
  RuntimeReset,
  SessionChanged,
  TerminalExited,
  TerminalSeen,
  TerminalState,
} from "@vibest/core/bus"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { WatchLagged, type WatchEvent } from "@vibest/protocol/rpc"
import { Cause, Context, Effect, Layer, PubSub, Queue, type Scope, Stream } from "effect"

import * as Listing from "./listing.ts"

export * as WatchFeed from "./watch-feed.ts"

export const WATCH_BACKLOG = 10_000

const watched = [SessionChanged, ProjectChanged, TerminalState, TerminalExited, TerminalSeen, RuntimeReset] as const

export const watchFanout = () => {
  const watchers = new Set<Queue.Queue<WatchEvent, WatchLagged>>()

  const failAll = (message: string) =>
    Effect.sync(() => {
      const failed = Array.from(watchers)
      watchers.clear()

      for (const watcher of failed) Queue.failCauseUnsafe(watcher, Cause.fail(new WatchLagged({ message })))
    })

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

  const subscribe = Effect.acquireRelease(
    Queue.dropping<WatchEvent, WatchLagged>(WATCH_BACKLOG).pipe(
      Effect.tap((queue) => Effect.sync(() => watchers.add(queue))),
    ),
    (queue) => Effect.sync(() => watchers.delete(queue)).pipe(Effect.andThen(Queue.shutdown(queue))),
  ).pipe(Effect.map(Stream.fromQueue))

  return {
    publish,
    failAll,
    subscribe,
    get size() {
      return watchers.size
    },
  }
}

export interface Interface {
  readonly subscribe: Effect.Effect<Stream.Stream<WatchEvent, WatchLagged>, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("vibest/WatchFeed") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const listing = yield* Listing.Service
    const fanout = watchFanout()

    const publishBatch = (batch: ReadonlyArray<BusEvent>) =>
      Effect.suspend(() =>
        fanout.size === 0
          ? Effect.void
          : listing.watchDeltas(batch).pipe(
              Effect.flatMap(Effect.forEach(fanout.publish, { discard: true })),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logError("Watch could not read a change", cause).pipe(
                      Effect.andThen(fanout.failAll("Watch could not read a change; reconnect for a new Snapshot")),
                    ),
              ),
            ),
      )

    const subscription = yield* bus.subscribe(watched)
    yield* Stream.fromEffectRepeat(PubSub.takeAll(subscription)).pipe(
      Stream.runForEach(publishBatch),
      Effect.forkScoped,
    )

    return Service.of({ subscribe: fanout.subscribe })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Bus.node, Listing.node],
})
