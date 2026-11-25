import { Db } from "@vibest/core/database/db"
import type { MachineLoad } from "@vibest/schema/machine"
import { LayerNode } from "@vibest/util/layer-node"
import { Cache, Clock, Context, Duration, Effect, Layer } from "effect"

export * as Load from "./load.ts"

const READING_TTL = Duration.seconds(5)

export type HostReading = Pick<MachineLoad, "cpu" | "memory">

export class HostSample extends Context.Service<HostSample, { readonly read: Effect.Effect<HostReading> }>()(
  "vibest/HostSample",
) {}

export const hostSampleNode = LayerNode.unbound(HostSample)

const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const host = yield* HostSample

  const sample = Effect.fn("Load.sample")(function* (): Effect.fn.Return<MachineLoad> {
    const reading = yield* host.read

    return {
      sampledAt: yield* Clock.currentTimeMillis,
      ...reading,
      executions: { working: yield* db.session.workingExecutions() },
    }
  })

  const cached = yield* Cache.make({
    capacity: 1,
    timeToLive: READING_TTL,
    lookup: (_key: "load") => sample(),
  })

  return {
    read: Effect.fn("Load.read")(() => Cache.get(cached, "load")),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Load") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Db.node, hostSampleNode],
})
