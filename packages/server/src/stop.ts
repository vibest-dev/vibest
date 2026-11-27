import { awaitEvent, Bus } from "@vibest/core/bus"
import type { Drain } from "@vibest/core/runtime/drain"
import { DaemonBusy, DaemonStopping } from "@vibest/protocol/errors"
import { Deferred, Duration, Effect, Option } from "effect"

export const DRAIN_TIMEOUT = Duration.seconds(5)

type Blocker = { readonly id: string; readonly reason: string }

export interface StopDeps {
  readonly drain: Drain.Interface
  readonly bus: Bus.Interface
  readonly shutdown: Deferred.Deferred<void>
}

export const stopOnce =
  ({ drain, bus, shutdown }: StopDeps) =>
  <E, R>(instance: string, method: string, takeOver: Effect.Effect<void, E, R>) =>
    Effect.gen(function* () {
      if (!(yield* drain.begin)) return yield* new DaemonStopping({ method })
      let last: Array<Blocker> = []
      const busy = (id: string) => ({ id, reason: "daemon operation still running" })

      const blockers = Effect.map(drain.pending, (pending) => {
        last = pending.map(busy)

        return last
      })

      const acceptedOnceIdle = Effect.gen(function* () {
        if ((yield* blockers).length > 0) return Option.none<true>()

        if (yield* drain.accept) return Option.some(true as const)
        last = (yield* drain.pending).map(busy)

        return Option.none<true>()
      })

      const reopenUnlessShuttingDown = Effect.flatMap(Deferred.isDone(shutdown), (done) =>
        done ? Effect.void : drain.reopen,
      )

      return yield* Effect.gen(function* () {
        const accepted = yield* awaitEvent(
          acceptedOnceIdle,
          (event) => (event.type === "drain.released" ? acceptedOnceIdle : Effect.succeed(Option.none())),
          DRAIN_TIMEOUT,
          Effect.map(acceptedOnceIdle, Option.isSome),
        ).pipe(Effect.provideService(Bus.Service, bus))

        if (!accepted) return yield* new DaemonBusy({ blockers: last })
        yield* Effect.uninterruptible(takeOver.pipe(Effect.andThen(Deferred.succeed(shutdown, undefined))))

        return { instance }
      }).pipe(Effect.onError(() => reopenUnlessShuttingDown))
    })
