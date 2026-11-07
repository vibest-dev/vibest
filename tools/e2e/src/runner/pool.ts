import childProcess from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { checkout } from "../world.ts"

export const shared = path.join(
  childProcess
    .spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: checkout })
    .stdout.toString()
    .trim() || path.join(checkout, ".git"),
  "vibest-e2e",
)

const cpus = os.availableParallelism()
const machineSlots = Math.max(2, cpus - 2)
const loadAdmitsMore = () => os.loadavg()[0]! < cpus
const slots = path.join(shared, "slots")

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const taken = async () => {
  const live: Array<string> = []
  for (const name of await fs.readdir(slots).catch(() => [] as Array<string>)) {
    const file = path.join(slots, name)
    const pid = Number((await fs.readFile(file, "utf8").catch(() => "")).split(" ")[0])
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) live.push(name)
    else await fs.rm(file, { force: true })
  }
  return live
}

const acquire = async (id: string, cap: number, gated: boolean): Promise<() => Promise<void>> => {
  await fs.mkdir(slots, { recursive: true })
  for (;;) {
    const busy = await taken()
    if (busy.length === 0 || (busy.length < cap && (!gated || loadAdmitsMore())))
      for (let k = 0; k < cap; k++) {
        const file = path.join(slots, String(k))
        const claimed = await fs.writeFile(file, `${process.pid} ${id}`, { flag: "wx" }).then(
          () => true,
          () => false,
        )
        if (claimed) return () => fs.rm(file, { force: true })
      }
    await Bun.sleep(250)
  }
}

export const pool = async <T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  run: (item: T) => Promise<void>,
  jobs: number | undefined,
) => {
  const cap = jobs ?? machineSlots
  const queue = [...items]
  const workers = Array.from({ length: Math.min(cap, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const release = await acquire(item.id, cap, jobs === undefined)
      try {
        await run(item)
      } finally {
        await release()
      }
    }
  })
  await Promise.all(workers)
}

const timingsFile = path.join(shared, "timings.json")

export const lastMs = async (): Promise<Record<string, number>> =>
  JSON.parse(await fs.readFile(timingsFile, "utf8").catch(() => "{}")) as Record<string, number>

export const saveMs = async (ms: Record<string, number>) => {
  await fs.mkdir(shared, { recursive: true })
  const merged = { ...(await lastMs()), ...ms }
  await fs.writeFile(`${timingsFile}.${process.pid}`, JSON.stringify(merged, null, 1))
  await fs.rename(`${timingsFile}.${process.pid}`, timingsFile)
}
