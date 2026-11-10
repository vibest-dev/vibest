import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

export const DAY_MS = 24 * 60 * 60 * 1000

export const worldTmpBase = () => (process.platform === "darwin" ? "/tmp" : os.tmpdir())

export const herdrConfigSessions = (home = os.homedir()) => path.join(home, ".config", "herdr", "sessions")

export const isWorldDirectoryName = (name: string) => /^vbe-[A-Za-z0-9]{6}$/.test(name)

export const worldOfHerdrSession = (name: string) => {
  const world = name.slice(0, "vbe-".length + 6)
  if (!isWorldDirectoryName(world)) return undefined
  if (name !== world && !name.startsWith(`${world}-`)) return undefined
  return world
}

export const sessionNamesForWorld = (names: ReadonlyArray<string>, world: string) =>
  names.filter((name) => name === world || name.startsWith(`${world}-`))

export const sweepTargets = (
  worlds: ReadonlyArray<{ name: string; mtimeMs: number }>,
  sessions: ReadonlyArray<{ name: string; mtimeMs: number }>,
  now: number,
  maxAgeMs = DAY_MS,
) => {
  const worldNames = new Set(worlds.map((world) => world.name))
  const expired = worlds.flatMap((world) =>
    isWorldDirectoryName(world.name) && now - world.mtimeMs > maxAgeMs ? [world.name] : [],
  )
  const expiredSet = new Set(expired)
  const sessionList = sessions.flatMap((session) => {
    const world = worldOfHerdrSession(session.name)
    if (world === undefined) return []
    if (expiredSet.has(world)) return [session.name]
    if (!worldNames.has(world) && now - session.mtimeMs > maxAgeMs) return [session.name]
    return []
  })
  return { worlds: expired, sessions: sessionList }
}

export const socketListening = (sock: string) =>
  new Promise<boolean>((resolve) => {
    let settled = false
    let socket: net.Socket | undefined
    const finish = (up: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      resolve(up)
    }
    const timer = setTimeout(() => finish(false), 500)
    fs.stat(sock).then(
      (st) => {
        if (settled) return
        if (!st.isSocket()) return finish(false)
        socket = net.connect(sock)
        socket.once("connect", () => finish(true))
        socket.once("error", () => finish(false))
      },
      () => finish(false),
    )
  })

export const pathsNamed = async (root: string, fileName: string) => {
  const found: Array<string> = []
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []))
    if (entry.name === fileName) found.push(path.join(entry.parentPath, entry.name))
  return found
}

export const removeStoppedSession = async (dir: string) => {
  if (await socketListening(path.join(dir, "herdr.sock"))) return false
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  return fs.stat(dir).then(
    () => false,
    () => true,
  )
}
