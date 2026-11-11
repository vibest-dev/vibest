import { Context, Effect, Layer } from "effect"

import { Drain } from "../drain.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { keyedLock } from "../keyed-lock.ts"

const make = Effect.gen(function* () {
  const drain = yield* Drain
  const locks = keyedLock<string>()
  return {
    ...locks,
    locked:
      (id: string, settlement = false) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        drain.work(`session ${id}`, locks.withLock(id)(effect), settlement),
  }
})

export class SessionLocks extends Context.Service<SessionLocks, Effect.Success<typeof make>>()("vibest/SessionLocks") {
  static readonly make = make

  static readonly layer = Layer.effect(SessionLocks, make)

  static readonly node = LayerNode.make({ service: SessionLocks, layer: SessionLocks.layer, deps: [Drain.node] })
}
