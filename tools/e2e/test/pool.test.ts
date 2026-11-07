import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { acquire } from "../src/runner/pool.ts"

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), "vbe-pool-test-"))
const deadPid = 2 ** 22 + 12_345
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => true), Bun.sleep(ms).then(() => false)])

describe("slot pool", () => {
  test("concurrent claims never share a slot, and each slot holds its owner's pid", async () => {
    const dir = await temp()
    const releases = await Promise.all(Array.from({ length: 12 }, (_, i) => acquire(`C${i}`, false, dir, 4)))
    const names = (await fs.readdir(dir)).filter((n) => !n.startsWith("."))
    expect(names.length).toBe(12)
    for (const n of names)
      expect((await fs.readFile(path.join(dir, n), "utf8")).startsWith(`${process.pid} `)).toBe(true)
    await Promise.all(releases.map((r) => r()))
    expect((await fs.readdir(dir)).length).toBe(0)
  })

  test("a young slot without a live owner is not taken over", async () => {
    const dir = await temp()
    await fs.writeFile(path.join(dir, "0"), "")
    const release = await acquire("A", false, dir, 4)
    expect(await fs.readFile(path.join(dir, "0"), "utf8")).toBe("")
    expect(await fs.readFile(path.join(dir, "1"), "utf8")).toBe(`${process.pid} A`)
    await release()
  })

  test("an old slot of a dead owner is reclaimed", async () => {
    const dir = await temp()
    await fs.writeFile(path.join(dir, "0"), `${deadPid} OLD`)
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(path.join(dir, "0"), old, old)
    const release = await acquire("A", false, dir, 4)
    expect(await fs.readFile(path.join(dir, "0"), "utf8")).toBe(`${process.pid} A`)
    await release()
  })

  test("a gated run waits while the machine's slots are full, whatever cap the other runs used", async () => {
    const dir = await temp()
    for (const n of ["0", "1", "5"]) await fs.writeFile(path.join(dir, n), `${process.pid} OTHER`)
    const idle = () => true
    expect(await within(acquire("G", true, dir, 3, idle), 600)).toBe(false)
    await fs.rm(path.join(dir, "5"))
    const release = await acquire("G", true, dir, 3, idle)
    expect(await fs.readFile(path.join(dir, "2"), "utf8")).toBe(`${process.pid} G`)
    await release()
  })

  test("a --jobs run is not held up by slots another run holds", async () => {
    const dir = await temp()
    for (const n of ["0", "1", "2", "3"]) await fs.writeFile(path.join(dir, n), `${process.pid} OTHER`)
    const release = await acquire("J", false, dir, 2)
    expect(await fs.readFile(path.join(dir, "4"), "utf8")).toBe(`${process.pid} J`)
    await release()
  })
})
