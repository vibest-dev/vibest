import os from "node:os"

import { Load } from "@vibest/server/machine/load"
import { Clock, Effect, FileSystem, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const SAMPLE = "200 millis"

interface CpuTimes {
  readonly idle: number
  readonly total: number
  readonly count: number
}

export const parseCpuList = (list: string): ReadonlySet<number> | undefined => {
  const cpus = new Set<number>()

  for (const range of list.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(range.trim())

    if (match === null) return undefined

    for (let cpu = Number(match[1]); cpu <= Number(match[2] ?? match[1]); cpu++) cpus.add(cpu)
  }

  return cpus
}

export const pinnedCpu = (stat: string, allowed: ReadonlySet<number>): CpuTimes | undefined => {
  const times = { idle: 0, total: 0, count: 0 }

  for (const [, id, fields] of stat.matchAll(/^cpu(\d+) (.+)$/gm)) {
    if (!allowed.has(Number(id))) continue
    const counters = (fields ?? "").trim().split(/\s+/).map(Number)
    const at = (index: number) => counters[index] ?? 0
    const idle = at(3) + at(4)
    times.idle += idle
    times.total += idle + at(0) + at(1) + at(2) + at(5) + at(6) + at(7)
    times.count++
  }

  return times.count > 0 ? times : undefined
}

const allCpus = (): CpuTimes => {
  const cpus = os.cpus()

  const sum = cpus.reduce(
    (acc, { times }) => ({
      idle: acc.idle + times.idle,
      total: acc.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  )

  return { ...sum, count: cpus.length }
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

const numberIn = (text: string, pattern: RegExp) => {
  const value = pattern.exec(text)?.[1]

  return value === undefined ? undefined : Number(value)
}

const hostShare = (before: CpuTimes, after: CpuTimes) => {
  const total = after.total - before.total
  const idle = after.idle - before.idle

  return before.count === after.count && total > 0 && idle >= 0 ? Math.min(1, Math.max(0, 1 - idle / total)) : null
}

export const cgroupsUpFrom = (path: string) => {
  const parts = path.split("/").filter((part) => part !== "")

  return parts.map((_, i) => `/sys/fs/cgroup/${parts.slice(0, parts.length - i).join("/")}`).concat("/sys/fs/cgroup")
}

const share = (max: RegExpExecArray) => Number(max[1]) / Number(max[2])

const cappedCpu = (
  max: RegExpExecArray,
  count: number,
  host: number | null,
  usedMicros: number | undefined,
  elapsedMicros: number,
) => {
  const capacity = Math.min(Number(max[1]) / Number(max[2]), count)
  const cgroupIdle = usedMicros !== undefined && elapsedMicros > 0 ? capacity - usedMicros / elapsedMicros : undefined
  const hostIdle = host === null ? undefined : count * (1 - host)
  const idles = [cgroupIdle, hostIdle].filter((idle) => idle !== undefined)
  const idle = idles.length === 0 ? undefined : Math.min(...idles)

  return {
    count: Math.max(1, Math.floor(capacity)),
    utilization: idle === undefined ? null : Math.min(1, Math.max(0, 1 - idle / capacity)),
  }
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const readFile = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""))

  const ownCgroups = Effect.map(readFile("/proc/self/cgroup"), (text) => {
    const path = /^0::(\/.*)$/m.exec(text)?.[1]

    return path === undefined ? [] : cgroupsUpFrom(path)
  })

  const tightestCpuMax = (groups: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      let tightest: { readonly group: string; readonly max: RegExpExecArray } | undefined

      for (const group of groups) {
        const max = /^(\d+) (\d+)$/.exec((yield* readFile(`${group}/cpu.max`)).trim())

        if (max !== null && (tightest === undefined || share(max) < share(tightest.max))) tightest = { group, max }
      }

      return tightest
    })

  const cpuOf = (groups: ReadonlyArray<string>, linux: boolean) =>
    Effect.gen(function* () {
      const limit = yield* tightestCpuMax(groups)

      const usage =
        limit === undefined
          ? Effect.succeed(undefined)
          : Effect.map(readFile(`${limit.group}/cpu.stat`), (stat) => numberIn(stat, /^usage_usec (\d+)$/m))

      const allowed = linux
        ? parseCpuList(/^Cpus_allowed_list:\s*(\S+)$/m.exec(yield* readFile("/proc/self/status"))?.[1] ?? "")
        : undefined

      const times =
        allowed === undefined
          ? Effect.sync(allCpus)
          : Effect.map(readFile("/proc/stat"), (stat) => pinnedCpu(stat, allowed) ?? allCpus())

      const before = yield* times
      const usageBefore = yield* usage
      const startedAt = yield* Clock.currentTimeMillis
      yield* Effect.sleep(SAMPLE)
      const after = yield* times
      const usageAfter = yield* usage
      const elapsedMicros = ((yield* Clock.currentTimeMillis) - startedAt) * 1000
      const host = hostShare(before, after)

      if (limit === undefined) return { count: after.count, utilization: host }
      const used = usageBefore === undefined || usageAfter === undefined ? undefined : usageAfter - usageBefore

      return cappedCpu(limit.max, after.count, host, used, elapsedMicros)
    })

  const vmStat = spawner.string(ChildProcess.make("/usr/bin/vm_stat", [], { stdin: "ignore", stderr: "ignore" })).pipe(
    Effect.timeout("1 second"),
    Effect.orElseSucceed(() => ""),
  )

  const hostAvailable = (platform: NodeJS.Platform) =>
    Effect.gen(function* () {
      if (platform === "linux") {
        const kib = numberIn(yield* readFile("/proc/meminfo"), /^MemAvailable:\s+(\d+)\s+kB$/m)

        return kib === undefined ? os.freemem() : kib * 1024
      }

      if (platform === "darwin") return darwinAvailableBytes(yield* vmStat) ?? os.freemem()

      return os.freemem()
    })

  const memoryLimit = (group: string) =>
    Effect.gen(function* () {
      const max = numberIn(yield* readFile(`${group}/memory.max`), /^(\d+)$/m)
      const current = max === undefined ? undefined : numberIn(yield* readFile(`${group}/memory.current`), /^(\d+)$/m)

      if (max === undefined || current === undefined) return undefined
      const reclaimable = numberIn(yield* readFile(`${group}/memory.stat`), /^inactive_file (\d+)$/m) ?? 0

      return { total: max, available: max - (current - reclaimable) }
    })

  const memoryOf = (groups: ReadonlyArray<string>, platform: NodeJS.Platform) =>
    Effect.gen(function* () {
      const host = { total: os.totalmem(), available: yield* hostAvailable(platform) }
      const limits = yield* Effect.forEach(groups, memoryLimit)

      return limits.reduce<{ total: number; available: number }>(
        (tightest, limit) =>
          limit === undefined
            ? tightest
            : {
                total: Math.min(tightest.total, limit.total),
                available: Math.min(tightest.available, limit.available),
              },
        host,
      )
    })

  const read = Effect.gen(function* () {
    const platform = os.platform()
    const linux = platform === "linux"
    const groups = linux ? yield* ownCgroups : []
    const cpu = yield* cpuOf(groups, linux)
    const { total, available } = yield* memoryOf(groups, platform)

    return { cpu, memory: { total, available: Math.min(total, Math.max(0, available)) } }
  })

  return { read }
})

export const layer = Layer.effect(Load.HostSample, make)
