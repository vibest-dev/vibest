import os from "node:os"

import { Load } from "@vibest/server/machine/load"
import { Duration, Effect, FileSystem, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const SAMPLE = Duration.millis(200)

const cpuSample = (): Load.CpuSample => {
  const cpus = os.cpus()

  const sum = cpus.reduce(
    (acc, cpu) => ({
      idle: acc.idle + cpu.times.idle,
      total: acc.total + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq,
    }),
    { idle: 0, total: 0 },
  )

  return { ...sum, count: cpus.length }
}

const wallClockPause = (duration: Duration.Duration) =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration))

    return Effect.sync(() => clearTimeout(timer))
  })

const withinTotal = (available: number, total: number) => Math.min(total, Math.max(0, available))

type HostMemory = { readonly cpuCap: number | undefined; readonly total: number; readonly available: number }

const atMost = (value: number, cap: number | undefined) => (cap === undefined ? value : Math.min(value, cap))

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const cgroup = <A>(name: string, parse: (text: string) => A | undefined) =>
    fs.readFileString(`/sys/fs/cgroup/${name}`).pipe(
      Effect.map(parse),
      Effect.orElseSucceed(() => undefined),
    )

  const linux = Effect.gen(function* () {
    const meminfo = yield* fs.readFileString("/proc/meminfo").pipe(Effect.orElseSucceed(() => ""))
    const cpuCap = yield* cgroup("cpu.max", Load.cgroupCpuCap)
    const memoryCap = yield* cgroup("memory.max", Load.cgroupBytes)
    const memoryUsed = yield* cgroup("memory.current", Load.cgroupBytes)
    const total = atMost(os.totalmem(), memoryCap)
    const host = Load.linuxAvailableBytes(meminfo) ?? os.freemem()
    const capped = memoryCap === undefined || memoryUsed === undefined ? host : Math.min(host, memoryCap - memoryUsed)

    return { cpuCap, total, available: withinTotal(capped, total) }
  })

  const darwin = spawner.string(ChildProcess.make("/usr/bin/vm_stat", [], { stdin: "ignore", stderr: "ignore" })).pipe(
    Effect.timeout("1 second"),
    Effect.orElseSucceed(() => ""),
    Effect.map((output) => {
      const total = os.totalmem()

      return {
        cpuCap: undefined,
        total,
        available: withinTotal(Load.darwinAvailableBytes(output) ?? os.freemem(), total),
      }
    }),
  )

  const other: Effect.Effect<HostMemory> = Effect.sync(() => ({
    cpuCap: undefined,
    total: os.totalmem(),
    available: os.freemem(),
  }))

  const byPlatform: Partial<Record<NodeJS.Platform, Effect.Effect<HostMemory>>> = { linux, darwin }
  const memory = byPlatform[os.platform()] ?? other

  const read = Effect.gen(function* () {
    const before = cpuSample()
    yield* wallClockPause(SAMPLE)
    const after = cpuSample()
    const { cpuCap, total, available } = yield* memory

    return {
      cpu: { count: atMost(after.count, cpuCap), utilization: Load.cpuShare(before, after) },
      memory: { total, available },
    }
  })

  return { read }
})

export const layer = Layer.effect(Load.HostSample, make)
