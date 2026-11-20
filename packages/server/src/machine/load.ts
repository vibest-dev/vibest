import { Db } from "@vibest/core/database/db"
import { LayerNode } from "@vibest/core/effect/layer-node"
import type { MachineLoad } from "@vibest/schema/machine"
import { Cache, Clock, Context, Duration, Effect, Layer } from "effect"

export * as Load from "./load.ts"

const READING_TTL = Duration.seconds(5)

export interface CpuSample {
  readonly idle: number
  readonly total: number
  readonly count: number
}

export type HostReading = Pick<MachineLoad, "cpu" | "memory">

export const cpuShare = (before: CpuSample, after: CpuSample): number | null => {
  const total = after.total - before.total
  const idle = after.idle - before.idle

  if (before.count !== after.count || total <= 0 || idle < 0) return null

  return Math.min(1, Math.max(0, 1 - idle / total))
}

export const darwinAvailableBytes = (output: string): number | undefined => {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1]
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1]
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1]
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1]

  if (pageSize === undefined || free === undefined || inactive === undefined || speculative === undefined)
    return undefined
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize)

  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : undefined
}

export const linuxAvailableBytes = (meminfo: string): number | undefined => {
  const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1]

  if (available === undefined) return undefined
  const bytes = Number(available) * 1024

  return Number.isSafeInteger(bytes) ? bytes : undefined
}

export const cgroupCpuCap = (cpuMax: string): number | undefined => {
  const [quota, period] = cpuMax.trim().split(/\s+/).map(Number)

  if (quota === undefined || period === undefined || !(quota > 0) || !(period > 0)) return undefined

  return Math.max(1, Math.ceil(quota / period))
}

export const cgroupBytes = (value: string): number | undefined => {
  const bytes = Number(value.trim())

  return value.trim() !== "" && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined
}

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
