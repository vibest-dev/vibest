import { Context, Effect, Layer } from "effect"

import { Drain } from "../drain.ts"
import { KeyedMutex } from "../effect/keyed-mutex.ts"
import { LayerNode } from "../effect/layer-node.ts"

export const directoryLock = (directory: string) => `directory:${directory}`

const make = Effect.gen(function* () {
  const drain = yield* Drain.Service
  const locks = yield* KeyedMutex.make<string>()
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

  static readonly node = LayerNode.make({
    service: SessionLocks,
    layer: SessionLocks.layer,
    deps: [Drain.node],
  })
}
