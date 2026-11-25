import os from "node:os"

import { afterEach, assert, describe, it, vi } from "@effect/vitest"
import { Load } from "@vibest/server/machine/load"
import { Clock, Effect, Fiber, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"

import { darwinAvailableBytes, layer } from "../src/host-sample.ts"

const MIB = 1024 ** 2

const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               2048.
Pages active:                            10000.
Pages inactive:                           4096.
Pages speculative:                         512.
Pages wired down:                         1024.
`

const busyFirstCpu = (now: number) =>
  Array.from({ length: 8 }, (_, i) => `cpu${i} ${i === 0 ? now : 0} 0 0 ${i === 0 ? 0 : now} 0 0 0 0`).join("\n")

const linuxRead = (cgroupPath: string, pinned: boolean, limitedAt: string, reclaimableMib: number) => {
  const own = `/sys/fs/cgroup${cgroupPath.replace(/\/$/, "")}`
  const root = `/sys/fs/cgroup${limitedAt.replace(/\/$/, "")}`

  const files = new Map<string, string>([
    ["/proc/self/cgroup", `0::${cgroupPath}\n`],
    ["/proc/meminfo", "MemAvailable: 2097152 kB\n"],
    ["/proc/self/status", `Cpus_allowed_list:\t${pinned ? "0" : "0-7"}\n`],
    [`${root}/cpu.max`, pinned ? "max 100000" : "100000 100000"],
    [`${root}/memory.max`, String(1024 * MIB)],
    [`${root}/memory.current`, String(600 * MIB)],
    [`${root}/memory.stat`, `inactive_file ${reclaimableMib * MIB}\n`],
  ])

  if (own !== root) {
    files.set(`${own}/cpu.max`, "max 100000")
    files.set(`${own}/memory.max`, "max")
  }

  const fs = FileSystem.layerNoop({
    readFileString: (path) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        if (path === "/proc/stat") return busyFirstCpu(now)

        if (path === `${root}/cpu.stat`) return `usage_usec ${now * 1000}\n`

        return files.get(path) ?? ""
      }),
  })

  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("no process on linux")),
  )

  return Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.flatMap(Load.HostSample, (sample) => sample.read))
    yield* TestClock.adjust("200 millis")

    return yield* Fiber.join(fiber)
  }).pipe(Effect.provide(layer.pipe(Layer.provide(Layer.merge(fs, spawner)))))
}

describe("host sample", () => {
  afterEach(() => vi.restoreAllMocks())

  it("darwin available memory is free plus inactive plus speculative pages", () => {
    assert.strictEqual(darwinAvailableBytes(vmStat), (2048 + 4096 + 512) * 16384)
    assert.strictEqual(darwinAvailableBytes("Pages free: 1.\n"), undefined)
  })

  it.effect(
    "on linux it reads what this process may use: the tightest limit from its own cgroup up, its CPUs, reclaimable cache",
    () =>
      Effect.gen(function* () {
        vi.spyOn(os, "platform").mockReturnValue("linux")
        vi.spyOn(os, "totalmem").mockReturnValue(4096 * MIB)
        vi.spyOn(os, "cpus").mockImplementation(() => {
          const now = Date.now()

          return Array.from({ length: 8 }, (_, i) => ({
            model: "test",
            speed: 0,
            times: { user: i === 0 ? now : 0, nice: 0, sys: 0, idle: i === 0 ? 0 : now, irq: 0 },
          }))
        })

        for (const [cgroup, pinned, limitedAt, reclaimable] of [
          ["/user.slice/vibest.scope", false, "/user.slice/vibest.scope", 100],
          ["/", false, "/", 100],
          ["/", true, "/", 100],
          ["/system.slice/vibest.service", false, "/", 0],
        ] as const) {
          const reading = yield* linuxRead(cgroup, pinned, limitedAt, reclaimable)
          const shown = `${cgroup} ${pinned ? "pinned" : "quota"}: ${JSON.stringify(reading)}`

          assert.strictEqual(reading.cpu.count, 1, shown)
          assert.strictEqual(reading.cpu.utilization, 1, shown)
          assert.strictEqual(reading.memory.total, 1024 * MIB, shown)
          assert.strictEqual(reading.memory.available, (1024 - (600 - reclaimable)) * MIB, shown)
        }
      }),
  )
})
