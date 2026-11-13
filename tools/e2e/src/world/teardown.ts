import fs from "node:fs/promises"
import path from "node:path"

import { commandOf, endOwned } from "../../../reap.ts"
import {
  DAY_MS,
  herdrConfigSessions,
  isWorldDirectoryName,
  pathsNamed,
  removeStoppedSession,
  socketListening,
  sweepTargets,
  worldOfHerdrSession,
  worldTmpBase,
} from "../runner/cleanup.ts"
import { alive } from "./alive.ts"

const datedDirs = async (dir: string, keep: (name: string) => boolean) => {
  const found: Array<{ name: string; mtimeMs: number }> = []
  for (const name of await fs.readdir(dir).catch(() => [] as Array<string>)) {
    if (!keep(name)) continue
    const st = await fs.lstat(path.join(dir, name)).catch(() => undefined)
    if (st?.isDirectory()) found.push({ name, mtimeMs: st.mtimeMs })
  }
  return found
}

const sessionOfSocket = (sock: string) => {
  const name = path.basename(path.dirname(sock))
  const sessions = path.dirname(path.dirname(sock))
  const herdrDir = path.dirname(sessions)
  if (path.basename(sessions) !== "sessions" || path.basename(herdrDir) !== "herdr") return undefined
  return { name, xdg: path.dirname(herdrDir) }
}

export const stopSocketsUnder = async (
  root: string,
  run: (args: ReadonlyArray<string>, env: Record<string, string>) => Promise<unknown>,
) => {
  for (const sock of await pathsNamed(root, "herdr.sock")) {
    const session = sessionOfSocket(sock)
    if (session === undefined) continue
    const env = { XDG_CONFIG_HOME: session.xdg }
    const forget = async (args: ReadonlyArray<string>) => {
      try {
        await run(args, env)
      } catch {
        return
      }
    }
    await forget(["session", "stop", session.name])
    await forget(["session", "delete", session.name])
    if (!(await socketListening(sock))) continue
    const pids = Bun.spawnSync(["lsof", "-t", sock], { stdout: "pipe", stderr: "ignore" })
      .stdout.toString()
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 1)
    for (const pid of new Set(pids)) {
      try {
        process.kill(pid, "SIGTERM")
      } catch (e) {
        if (!(e instanceof Error) || !("code" in e) || e.code !== "ESRCH") throw e
      }
    }
    const deadline = Date.now() + 5_000
    while ((await socketListening(sock)) && Date.now() < deadline) await Bun.sleep(50)
    if (!(await socketListening(sock))) continue
    for (const pid of new Set(pids)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch (e) {
        if (!(e instanceof Error) || !("code" in e) || e.code !== "ESRCH") throw e
      }
    }
  }
}

export const endHerdrSocket = async (sock: string, name: string) => {
  if (!(await socketListening(sock))) return
  const pids = Bun.spawnSync(["lsof", "-t", sock], { stdout: "pipe", stderr: "ignore" })
    .stdout.toString()
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 1)
  for (const pid of new Set(pids)) {
    const command = commandOf(pid)
    if (command.includes("herdr") && command.includes(name)) endOwned(pid, name)
  }
}

export const stopRecordedDaemon = async (root: string) => {
  for (const file of await pathsNamed(root, "vibestd.pid")) {
    const text = await fs.readFile(file, "utf8").catch(() => "")
    let pid: number | undefined
    let socket = ""
    try {
      const parsed = JSON.parse(text) as { pid?: unknown; socket?: unknown }
      if (typeof parsed.pid === "number") pid = parsed.pid
      if (typeof parsed.socket === "string") socket = parsed.socket
    } catch {
      continue
    }
    if (pid === undefined || socket === "" || !alive(pid)) continue
    const realRoot = await fs.realpath(root).catch(() => root)
    const realSocket = await fs.realpath(socket).catch(() => socket)
    const under = (dir: string, target: string) => target === dir || target.startsWith(dir + path.sep)
    if (![root, realRoot].some((dir) => [socket, realSocket].some((target) => under(dir, target)))) continue
    if (!commandOf(pid).includes("daemon --foreground")) continue
    try {
      process.kill(pid, "SIGTERM")
    } catch (e) {
      if (!(e instanceof Error) || !("code" in e) || e.code !== "ESRCH") throw e
      continue
    }
    for (const deadline = Date.now() + 2_000; alive(pid) && Date.now() < deadline;) await Bun.sleep(50)
    if (alive(pid)) endOwned(pid, "daemon --foreground")
  }
}

const herdrRun = async (args: ReadonlyArray<string>, extra: Record<string, string> = {}) => {
  const env: Record<string, string> = { ...extra }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("HERDR_") && env[key] === undefined) env[key] = value
  }
  const child = Bun.spawn(["herdr", ...args], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  const timer = setTimeout(() => child.kill(), 20_000)
  await child.exited
  clearTimeout(timer)
}

const worldDirExists = (root: string) =>
  fs.stat(root).then(
    () => true,
    () => false,
  )

export const stopOwners = async (root: string) => {
  const listed = Bun.spawnSync(["lsof", "-t", "+D", root], { stdout: "pipe", stderr: "ignore" }).stdout.toString()
  const pids = [
    ...new Set(
      listed
        .split(/\s+/)
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid),
    ),
  ]
  const doomed: Array<number> = []
  for (const pid of pids) {
    const command = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]).stdout.toString()
    if (!/(herdr|hc|vibest)/.test(command) || command.includes("tools/e2e")) continue
    doomed.push(pid)
    try {
      process.kill(pid, "SIGTERM")
    } catch (e) {
      if (!(e instanceof Error) || !("code" in e) || e.code !== "ESRCH") throw e
    }
  }
  const deadline = Date.now() + 2_000
  while (doomed.some((pid) => alive(pid)) && Date.now() < deadline) await Bun.sleep(50)
  for (const pid of doomed) {
    if (!alive(pid)) continue
    try {
      process.kill(pid, "SIGKILL")
    } catch (e) {
      if (!(e instanceof Error) || !("code" in e) || e.code !== "ESRCH") throw e
    }
  }
}

export const removeWorldDir = async (root: string) => {
  const deadline = Date.now() + 20_000
  let removed = false
  while (Date.now() < deadline) {
    if (await worldDirExists(root)) {
      removed = true
      await stopOwners(root)
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
      await Bun.sleep(200)
      continue
    }
    if (!removed) return
    await Bun.sleep(1_000)
    if (!(await worldDirExists(root))) return
  }
}

export const removeExpiredWorlds = async (
  options: {
    tmpBase?: string
    sessionsDir?: string
    now?: number
    maxAgeMs?: number
    run?: (args: ReadonlyArray<string>, env?: Record<string, string>) => Promise<unknown>
  } = {},
) => {
  const tmpBase = options.tmpBase ?? worldTmpBase()
  const sessionsDir = options.sessionsDir ?? herdrConfigSessions()
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? DAY_MS
  const run = options.run ?? herdrRun
  const forget = async (task: () => Promise<unknown>) => {
    try {
      await task()
    } catch {
      return
    }
  }
  const worlds = await datedDirs(tmpBase, isWorldDirectoryName)
  const sessions = await datedDirs(sessionsDir, (name) => worldOfHerdrSession(name) !== undefined)
  const targets = sweepTargets(worlds, sessions, now, maxAgeMs)
  const stuck = new Set<string>()
  for (const world of targets.worlds) {
    const root = path.join(tmpBase, world)
    await stopRecordedDaemon(root)
    await stopSocketsUnder(root, run)
  }
  for (const name of targets.sessions) {
    const world = worldOfHerdrSession(name)
    await forget(() => run(["session", "stop", name]))
    await forget(() => run(["session", "delete", name]))
    if (!(await removeStoppedSession(path.join(sessionsDir, name))) && world !== undefined) stuck.add(world)
  }
  for (const world of targets.worlds) {
    if (stuck.has(world)) continue
    await removeWorldDir(path.join(tmpBase, world))
  }
}
