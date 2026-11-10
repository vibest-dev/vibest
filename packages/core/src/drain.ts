import { Context, Deferred, Effect, Layer } from "effect"

import { Bus } from "./bus.ts"
import { LayerNode } from "./effect/layer-node.ts"

const make = Effect.gen(function* () {
  const bus = yield* Bus
  let phase: "open" | "draining" | "accepted" = "open"
  let reopened = yield* Deferred.make<void>()
  const active = new Map<object, string>()
  const track = (label: string) => {
    const token = {}
    active.set(token, label)
    return Effect.suspend(() => (active.delete(token) ? bus.observe({ type: "live.drain" }) : Effect.void))
  }
  const enter = (label: string, settlement: boolean): Effect.Effect<Effect.Effect<void>> =>
    Effect.suspend(() =>
      phase === "open" || (settlement && phase === "draining")
        ? Effect.succeed(track(label))
        : Deferred.await(reopened).pipe(Effect.andThen(enter(label, settlement))),
    )
  return {
    track,
    work: <A, E, R>(label: string, body: Effect.Effect<A, E, R>, settlement = false) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.acquireUseRelease(
          restore(enter(label, settlement)),
          () => restore(body),
          (leave) => leave,
        ),
      ),
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
      if (phase === "open") return
      const next = yield* Deferred.make<void>()
      const waiting = reopened
      reopened = next
      phase = "open"
      yield* Deferred.succeed(waiting, undefined)
    }),
  }
})

export class Drain extends Context.Service<Drain, Effect.Success<typeof make>>()("vibest/Drain") {
  static readonly layer = Layer.effect(Drain, make)

  static readonly node = LayerNode.make({ service: Drain, layer: Drain.layer, deps: [Bus.node] })
}
