import { awaitEvent, Bus } from "@vibest/core/bus"
import type { Drain } from "@vibest/core/drain"
import { DaemonBusy, DaemonStopping } from "@vibest/protocol/rpc"
import { Deferred, Duration, Effect, Option } from "effect"

export const DRAIN_TIMEOUT = Duration.seconds(5)

type Blocker = { readonly id: string; readonly reason: string }

export interface StopDeps {
  readonly drain: Drain["Service"]
  readonly bus: Bus["Service"]
  readonly sendingInbox: Effect.Effect<
    ReadonlyArray<{ readonly id: number; readonly kind: string; readonly sessionId: string }>
  >
  readonly shutdown: Deferred.Deferred<void>
}

export const stopOnce =
  ({ drain, bus, sendingInbox, shutdown }: StopDeps) =>
  <E, R>(instance: string, method: string, takeOver: Effect.Effect<void, E, R>) =>
    Effect.gen(function* () {
      if (!(yield* drain.begin)) return yield* new DaemonStopping({ method })
      let last: Array<Blocker> = []
      const busy = (id: string) => ({ id, reason: "daemon operation still running" })
      const blockers = Effect.gen(function* () {
        last = (yield* drain.pending).map(busy)
        if (last.length > 0) return last
        last = [{ id: "inbox", reason: "checking unsettled delivery" }]
        last = (yield* sendingInbox).map((row) => ({
          id: `inbox ${row.id}`,
          reason: `${row.kind} for session ${row.sessionId}: delivery not settled`,
        }))
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
          (event) =>
            event.type === "live.drain" || event.type === "inbox.status"
              ? acceptedOnceIdle
              : Effect.succeed(Option.none()),
          DRAIN_TIMEOUT,
          Effect.map(acceptedOnceIdle, Option.isSome),
        ).pipe(Effect.provideService(Bus, bus))
        if (!accepted) return yield* new DaemonBusy({ blockers: last })
        yield* Effect.uninterruptible(takeOver.pipe(Effect.andThen(Deferred.succeed(shutdown, undefined))))
        return { instance }
      }).pipe(Effect.onError(() => reopenUnlessShuttingDown))
    })
