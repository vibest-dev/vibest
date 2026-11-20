import { assert, describe, it } from "@effect/vitest"
import {
  cgroupBytes,
  cgroupCpuCap,
  cpuShare,
  darwinAvailableBytes,
  linuxAvailableBytes,
} from "@vibest/server/machine/load"

const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               2048.
Pages active:                            10000.
Pages inactive:                           4096.
Pages speculative:                         512.
Pages wired down:                         1024.
`

describe("machine load", () => {
  it("darwin available memory is free plus inactive plus speculative pages", () => {
    assert.strictEqual(darwinAvailableBytes(vmStat), (2048 + 4096 + 512) * 16384)
    assert.strictEqual(darwinAvailableBytes("Pages free: 1.\n"), undefined)
  })

  it("linux available memory is MemAvailable, not MemFree", () => {
    const meminfo = "MemTotal: 100000 kB\nMemFree: 1000 kB\nMemAvailable: 123456 kB\n"
    assert.strictEqual(linuxAvailableBytes(meminfo), 123456 * 1024)
    assert.strictEqual(linuxAvailableBytes("MemFree: 1000 kB\n"), undefined)
  })

  it("cpu share is the non-idle part of the sample", () => {
    const before = { idle: 100, total: 200, count: 8 }
    assert.strictEqual(cpuShare(before, { idle: 150, total: 300, count: 8 }), 0.5)
    assert.strictEqual(cpuShare(before, { idle: 150, total: 300, count: 4 }), null)
    assert.strictEqual(cpuShare(before, { idle: 90, total: 300, count: 8 }), null)
  })

  it("a cgroup cap is read from cpu.max and memory.max, and max means none", () => {
    assert.strictEqual(cgroupCpuCap("150000 100000\n"), 2)
    assert.strictEqual(cgroupCpuCap("max 100000\n"), undefined)
    assert.strictEqual(cgroupBytes("536870912\n"), 536870912)
    assert.strictEqual(cgroupBytes("max\n"), undefined)
  })
})
