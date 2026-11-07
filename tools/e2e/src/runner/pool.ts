import childProcess from "node:child_process"
import crypto from "node:crypto"
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

const GRACE_MS = 5_000

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const ownerAlive = (text: string) => {
  const pid = Number(text.split(" ")[0])
  return Number.isInteger(pid) && pid > 0 && alive(pid)
}

const taken = async (dir: string) => {
  let live = 0
  for (const name of await fs.readdir(dir).catch(() => [] as Array<string>)) {
    if (name.startsWith(".")) continue
    const file = path.join(dir, name)
    const seen = await fs.stat(file).catch(() => undefined)
    if (seen === undefined) continue
    if (ownerAlive(await fs.readFile(file, "utf8").catch(() => "")) || Date.now() - seen.mtimeMs < GRACE_MS) {
      live++
      continue
    }
    const tomb = path.join(dir, `.stale-${process.pid}-${crypto.randomUUID()}`)
    if (
      !(await fs.rename(file, tomb).then(
        () => true,
        () => false,
      ))
    )
      continue
    if ((await fs.stat(tomb)).ino !== seen.ino) await fs.link(tomb, file).catch(() => undefined)
    await fs.rm(tomb, { force: true })
  }
  return live
}

const claim = async (dir: string, name: string, owner: string) => {
  const draft = path.join(dir, `.claim-${process.pid}-${crypto.randomUUID()}`)
  await fs.writeFile(draft, owner)
  try {
    return await fs.link(draft, path.join(dir, name)).then(
      () => true,
      () => false,
    )
  } finally {
    await fs.rm(draft, { force: true })
  }
}

export const acquire = async (
  id: string,
  gated: boolean,
  dir = slots,
  cap = machineSlots,
): Promise<() => Promise<void>> => {
  await fs.mkdir(dir, { recursive: true })
  for (;;) {
    const busy = await taken(dir)
    if (!gated || busy === 0 || (busy < cap && loadAdmitsMore()))
      for (let k = 0; k <= busy; k++)
        if (await claim(dir, String(k), `${process.pid} ${id}`))
          return () => fs.rm(path.join(dir, String(k)), { force: true })
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
      const release = await acquire(item.id, jobs === undefined)
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
