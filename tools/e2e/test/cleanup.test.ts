import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { DAY_MS, pathsNamed, sweepTargets } from "../src/runner/cleanup.ts"
import { removeExpiredWorlds } from "../src/world.ts"

test("a kept world and its sessions are swept only once they are a day old", () => {
  const now = 10 * DAY_MS
  const old = now - DAY_MS - 1
  const young = now - 1
  const targets = sweepTargets(
    [
      { name: "vbe-AbC123", mtimeMs: old },
      { name: "vbe-Exact1", mtimeMs: now - DAY_MS },
      { name: "vbe-XyZ789", mtimeMs: young },
      { name: "vbe-not-a-world", mtimeMs: old },
    ],
    [
      { name: "vbe-AbC123", mtimeMs: young },
      { name: "vbe-AbC123-inbox", mtimeMs: old },
      { name: "vbe-XyZ789-other", mtimeMs: old },
      { name: "vbe-OldOr1", mtimeMs: old },
      { name: "vbe-NewOr1", mtimeMs: young },
      { name: "vibest", mtimeMs: old },
      { name: "vbt-30ad4ae9", mtimeMs: old },
    ],
    now,
  )
  expect(targets.worlds).toEqual(["vbe-AbC123"])
  expect(targets.sessions).toEqual(["vbe-AbC123", "vbe-AbC123-inbox", "vbe-OldOr1"])
})

test("a herdr socket nested in a world is found by name", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vbe-cleanup-test-"))
  const dir = path.join(root, "b", "c", "herdr", "sessions", "default")
  await fs.mkdir(dir, { recursive: true })
  const server = net.createServer()
  server.unref()
  const sock = path.join(dir, "herdr.sock")
  try {
    await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
    expect(await pathsNamed(root, "herdr.sock")).toEqual([sock])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("the sweep removes an old world with its herdr sessions, and leaves a live one", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vbe-cleanup-test-"))
  const sessions = path.join(tmp, "sessions")
  await fs.mkdir(sessions)
  const now = Date.now()
  const oldAt = new Date(now - 2 * DAY_MS)
  const touch = async (dir: string, at: Date) => {
    await fs.mkdir(dir, { recursive: true })
    await fs.utimes(dir, at, at)
  }
  const server = net.createServer()
  server.unref()
  try {
    await touch(path.join(tmp, "vbe-AbC123"), oldAt)
    await touch(path.join(sessions, "vbe-AbC123"), oldAt)
    await touch(path.join(sessions, "vbe-AbC123-inbox"), oldAt)
    await touch(path.join(tmp, "vbe-XyZ789"), new Date(now))
    await touch(path.join(sessions, "vbe-XyZ789"), new Date(now))
    await touch(path.join(tmp, "vbe-not-a-world"), oldAt)
    await touch(path.join(sessions, "vibest"), oldAt)
    await touch(path.join(sessions, "vbe-OldOr1"), oldAt)
    await touch(path.join(sessions, "vbe-NewOr1"), new Date(now))
    const unrelated = path.join(tmp, "vbe-Live01")
    await touch(unrelated, oldAt)
    await fs.mkdir(path.join(unrelated, "vibest"), { recursive: true })
    await fs.writeFile(
      path.join(unrelated, "vibest", "vibestd.pid"),
      JSON.stringify({ pid: process.pid, socket: path.join(unrelated, "vibest", "vibest.sock") }),
    )
    await fs.utimes(unrelated, oldAt, oldAt)
    const busy = path.join(tmp, "vbe-Busy01")
    const busySession = path.join(sessions, "vbe-Busy01")
    await touch(busy, oldAt)
    await touch(busySession, oldAt)
    await new Promise<void>((resolve) => server.listen(path.join(busySession, "herdr.sock"), () => resolve()))
    const ran: Array<string> = []
    await removeExpiredWorlds({
      tmpBase: tmp,
      sessionsDir: sessions,
      now,
      run: async (args) => {
        ran.push(args.join(" "))
      },
    })
    const exists = (file: string) =>
      fs.stat(file).then(
        () => true,
        () => false,
      )
    expect(await exists(path.join(tmp, "vbe-AbC123"))).toBe(false)
    expect(await exists(path.join(sessions, "vbe-AbC123"))).toBe(false)
    expect(await exists(path.join(sessions, "vbe-AbC123-inbox"))).toBe(false)
    expect(await exists(path.join(sessions, "vbe-OldOr1"))).toBe(false)
    expect(await exists(path.join(tmp, "vbe-XyZ789"))).toBe(true)
    expect(await exists(path.join(sessions, "vbe-XyZ789"))).toBe(true)
    expect(await exists(path.join(sessions, "vbe-NewOr1"))).toBe(true)
    expect(await exists(path.join(tmp, "vbe-not-a-world"))).toBe(true)
    expect(await exists(path.join(sessions, "vibest"))).toBe(true)
    expect(await exists(unrelated)).toBe(false)
    expect(process.kill(process.pid, 0)).toBe(true)
    expect(await exists(busy)).toBe(true)
    expect(await exists(busySession)).toBe(true)
    expect(ran).toContain("session stop vbe-AbC123")
    expect(ran).toContain("session stop vbe-AbC123-inbox")
    expect(ran).toContain("session stop vbe-Busy01")
    expect(
      ran.some((line) => line.includes("vibest") || line.includes("vbe-XyZ789") || line.includes("vbe-NewOr1")),
    ).toBe(false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(tmp, { recursive: true, force: true })
  }
}, 30_000)
