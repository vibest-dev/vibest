// Planned shutdown (Daemon.Stop) tracks daemon operations, not agent lifetimes: agents keep running and pending
// Messages stay in sqlite for the next vibestd. Work deferred while draining wakes once a refused Stop reopens.
import { Context, Deferred, Effect, Layer } from "effect"

import { Bus } from "./bus.ts"

const make = Effect.gen(function* () {
  const bus = yield* Bus
  let phase: "open" | "draining" | "accepted" = "open"
  let reopened = yield* Deferred.make<void>()
  const active = new Map<object, string>()
  const track = (label: string) => {
    const token = {}
    active.set(token, label)
    return Effect.gen(function* () {
      if (!active.delete(token)) return
      yield* bus.observe({ type: "live.drain" })
    })
  }
  const enter = (label: string, settlement: boolean): Effect.Effect<Effect.Effect<void>> =>
    Effect.suspend(() =>
      phase === "open" || (settlement && phase === "draining")
        ? Effect.succeed(track(label))
        : Deferred.await(reopened).pipe(Effect.andThen(enter(label, settlement))),
    )
  return {
    /** Count already-admitted work handed to a queue or fork, with no gap in the accounting. Returns its release. */
    track,
    /** Run `body` counted; while draining it waits for a reopen, unless it settles work already started (`settlement`). */
    work: <A, E, R>(label: string, body: Effect.Effect<A, E, R>, settlement = false) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.acquireUseRelease(
          restore(enter(label, settlement)),
          () => restore(body),
          (leave) => leave,
        ),
      ),
    /** At the RPC entry: the release when admitted now, else undefined (refused, never waits). */
    admit: (label: string, settlement = false) =>
      Effect.sync(() => (phase === "open" || (settlement && phase === "draining") ? track(label) : undefined)),
    begin: Effect.sync(() => {
      if (phase !== "open") return false
      phase = "draining"
      return true
    }),
    phase: Effect.sync(() => phase),
    pending: Effect.sync(() => [...active.values()]),
    accept: Effect.sync(() => {
      if (phase !== "draining" || active.size !== 0) return false
      phase = "accepted"
      return true
    }),
    reopen: Effect.gen(function* () {
      if (phase !== "draining") return
      const next = yield* Deferred.make<void>()
      const waiting = reopened
      reopened = next
      phase = "open"
      yield* Deferred.succeed(waiting, undefined)
    }),
  }
})

/** One per vibestd, shared by the RPC server, Inbox and Sessions. */
export class Drain extends Context.Service<Drain, Effect.Success<typeof make>>()("vibest/Drain") {
  static readonly layer = Layer.effect(Drain, make)
}
