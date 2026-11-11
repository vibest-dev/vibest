import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { HerdrPool } from "@vibest/runtime-herdr/pool"
import * as TerminalRuntime from "@vibest/runtime-herdr/terminal-runtime"
import { fromPool } from "@vibest/runtime-herdr/terminal-runtime"
import { Effect, Layer } from "effect"
import { FileSystem } from "effect"
import { ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

import { commandOf, endOwned, note } from "../../../tools/reap.ts"

export const herdrOnPath = childProcess.spawnSync("herdr", ["--version"], { stdio: "ignore" }).status === 0
export const piOnPath = (process.env.PATH ?? "")
  .split(":")
  .some((dir) => dir !== "" && fs.existsSync(path.join(dir, "pi")))
export const barePiArgv = ["pi", "--no-extensions", "--no-mcp", "--no-skills", "--no-session"]
export const coldPiStartupAttempts = 1400

export const herdrChildEnv = () => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("HERDR_") && !key.startsWith("VIBEST_")) env[key] = value
  }
  return env
}

export const sessionName = /^vbt-[0-9a-f]{8}$/
export const started = new Set<string>()
export const children = new Map<string, ReturnType<typeof childProcess.spawn>>()

export type ListedSession = { name?: string; running?: boolean; socket_path?: string }

export const readSessions = (): ReadonlyArray<ListedSession> | undefined => {
  const listed = childProcess.spawnSync("herdr", ["session", "list", "--json"], {
    env: herdrChildEnv(),
    encoding: "utf8",
  })
  if (listed.status !== 0 || !listed.stdout) return undefined
  try {
    const json = JSON.parse(listed.stdout) as { sessions?: Array<ListedSession> }
    return json.sessions ?? []
  } catch {
    return undefined
  }
}

const sessionDirectory = (name: string, env: Record<string, string>) =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "herdr", "sessions", name)

const socketListening = (sock: string) =>
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
    fs.stat(sock, (error, st) => {
      if (settled) return
      if (error || !st.isSocket()) return finish(false)
      socket = net.connect(sock)
      socket.once("connect", () => finish(true))
      socket.once("error", () => finish(false))
    })
  })

const holders = (sock: string) =>
  childProcess
    .spawnSync("lsof", ["-t", sock], { encoding: "utf8" })
    .stdout.split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 1)

const endHerdr = (pid: number | undefined, name: string) => {
  if (pid === undefined) return
  const command = commandOf(pid)
  if (!command.includes("herdr") || !command.includes(name)) return
  endOwned(pid, name)
}

export const stopSession = async (name: string) => {
  if (!sessionName.test(name)) return
  const env = herdrChildEnv()
  const dir = sessionDirectory(name, env)
  const sock = path.join(dir, "herdr.sock")
  endHerdr(children.get(name)?.pid, name)
  for (const pid of holders(sock)) endHerdr(pid, name)
  childProcess.spawnSync("herdr", ["session", "stop", name], { env, stdio: "ignore", timeout: 2_000 })
  const deadline = Date.now() + 2_000
  while ((await socketListening(sock)) && Date.now() < deadline) {
    for (const pid of holders(sock)) endHerdr(pid, name)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!(await socketListening(sock))) {
    childProcess.spawnSync("herdr", ["session", "delete", name], { env, stdio: "ignore", timeout: 2_000 })
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const left = holders(sock).filter((pid) => {
    const command = commandOf(pid)
    return command.includes("herdr") && command.includes(name)
  })
  if (left.length > 0) throw new Error(`herdr ${name} still running (${left.join(", ")})`)
  if (fs.existsSync(dir)) throw new Error(`herdr session ${name} is still at ${dir}`)
  started.delete(name)
  children.delete(name)
}

export const stopStartedSessions = async () => {
  const failed: Array<string> = []
  for (const name of started) {
    try {
      await stopSession(name)
    } catch {
      failed.push(name)
    }
  }
  if (failed.length > 0) throw new Error(`herdr sessions left: ${failed.join(", ")}`)
}

export const socketOf = (name: string) => {
  const found = readSessions()?.find((session) => session.name === name && session.running && session.socket_path)
  return found?.socket_path !== undefined && fs.existsSync(found.socket_path) ? found.socket_path : undefined
}

export const layer = HerdrPool.layer.pipe(Layer.provideMerge(Platform.services))

export const loadedSuiteAttempts = 200

export const waitFor = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  ready: (value: A) => boolean,
  label: string,
  attempts = loadedSuiteAttempts,
) =>
  Effect.gen(function* () {
    let last = ""
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = yield* read
      if (ready(value)) return value
      last = JSON.stringify(value)
      yield* Effect.sleep("100 millis")
    }
    return yield* Effect.die(new Error(`${label}: ${last}`))
  })

export const withSession = <A, E, R>(
  use: (session: { readonly name: string; readonly socketPath: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const name = `vbt-${crypto.randomBytes(4).toString("hex")}`
    started.add(name)
    const child = childProcess.spawn("herdr", ["--session", name, "server"], {
      env: herdrChildEnv(),
      detached: true,
      stdio: "ignore",
    })
    child.unref()
    children.set(name, child)
    note(child.pid, `herdr --session ${name} server`)
    yield* Effect.addFinalizer(() => Effect.promise(() => stopSession(name)))
    let socketPath: string | undefined
    for (let attempt = 0; attempt < 50 && socketPath === undefined; attempt++) {
      socketPath = socketOf(name)
      if (socketPath === undefined) yield* Effect.sleep("200 millis")
    }
    if (socketPath === undefined) return yield* Effect.die(new Error(`herdr session ${name} did not come up`))
    return yield* use({ name, socketPath })
  })

export const withRuntime = <A, E, R>(use: (runtime: TerminalRuntime.Runtime) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const runtime = yield* fromPool({
      pool: yield* HerdrPool,
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      fs: yield* FileSystem.FileSystem,
      scope: yield* Effect.scope,
    })
    return yield* use(runtime)
  })

export const git = (cwd: string | undefined, ...args: string[]) => {
  const run = childProcess.spawnSync("git", args, { cwd, encoding: "utf8", env: herdrChildEnv() })
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${(run.stderr ?? run.stdout ?? "").trim()}`)
  return (run.stdout ?? "").trim()
}
