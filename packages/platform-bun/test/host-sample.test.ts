import os from "node:os"

import { afterEach, assert, describe, it, vi } from "@effect/vitest"
import { Load } from "@vibest/server/machine/load"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"

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

const linuxRead = (cgroupPath: string, pinned: boolean) => {
  const root = `/sys/fs/cgroup${cgroupPath.replace(/\/$/, "")}`

  const files = new Map([
    ["/proc/self/cgroup", `0::${cgroupPath}\n`],
    ["/proc/meminfo", "MemAvailable: 2097152 kB\n"],
    ["/proc/self/status", `Cpus_allowed_list:\t${pinned ? "0" : "0-7"}\n`],
    [`${root}/cpu.max`, pinned ? "max 100000" : "100000 100000"],
    [`${root}/memory.max`, String(1024 * MIB)],
    [`${root}/memory.current`, String(600 * MIB)],
    [`${root}/memory.stat`, `inactive_file ${100 * MIB}\n`],
  ])

  const fs = FileSystem.layerNoop({
    readFileString: (path) =>
      Effect.sync(() => {
        if (path === "/proc/stat") return busyFirstCpu(Date.now())

        if (path === `${root}/cpu.stat`) return `usage_usec ${Date.now() * 1000}\n`

        return files.get(path) ?? ""
      }),
  })

  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("no process on linux")),
  )

  return Effect.runPromise(
    Effect.flatMap(Load.HostSample, (sample) => sample.read).pipe(
      Effect.provide(layer.pipe(Layer.provide(Layer.merge(fs, spawner)))),
    ),
  )
}

describe("host sample", () => {
  afterEach(() => vi.restoreAllMocks())

  it("darwin available memory is free plus inactive plus speculative pages", () => {
    assert.strictEqual(darwinAvailableBytes(vmStat), (2048 + 4096 + 512) * 16384)
    assert.strictEqual(darwinAvailableBytes("Pages free: 1.\n"), undefined)
  })

  it("on linux it reads what this process may use: its own cgroup, its CPUs, reclaimable cache", async () => {
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

    for (const [cgroup, pinned] of [
      ["/user.slice/vibest.scope", false],
      ["/", false],
      ["/", true],
    ] as const) {
      const reading = await linuxRead(cgroup, pinned)
      const shown = `${cgroup} ${pinned ? "pinned" : "quota"}: ${JSON.stringify(reading)}`

      assert.strictEqual(reading.cpu.count, 1, shown)
      assert.isAbove(reading.cpu.utilization ?? 0, 0.97, shown)
      assert.strictEqual(reading.memory.total, 1024 * MIB, shown)
      assert.strictEqual(reading.memory.available, 524 * MIB, shown)
    }
  })
})
