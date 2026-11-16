import { Context, Effect, Layer } from "effect"

import { Drain } from "../drain.ts"
import { KeyedMutex } from "../effect/keyed-mutex.ts"
import { LayerNode } from "../effect/layer-node.ts"

export * as SessionLocks from "./locks.ts"

export const directoryLock = (directory: string) => `directory:${directory}`

export const make = Effect.gen(function* () {
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

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/SessionLocks") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Drain.node],
})
