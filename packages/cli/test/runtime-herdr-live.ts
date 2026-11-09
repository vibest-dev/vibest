import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { HerdrPool } from "@vibest/runtime-herdr/pool"
import * as TerminalRuntime from "@vibest/runtime-herdr/terminal-runtime"
import { fromPool } from "@vibest/runtime-herdr/terminal-runtime"
import { Effect, Layer } from "effect"
import { FileSystem } from "effect"
import { ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

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

export const signalablePid = (pid: number) => pid > 1

export const livePid = (child: ReturnType<typeof childProcess.spawn> | undefined) => {
  const pid = child?.pid
  return child?.exitCode === null && child?.signalCode === null && pid !== undefined && signalablePid(pid)
    ? pid
    : undefined
}

export const killDetachedProcessGroup = (leader: number) => {
  try {
    process.kill(-leader, "SIGKILL")
    return true
  } catch {
    return false
  }
}

export const stopSession = async (name: string) => {
  if (!sessionName.test(name)) return
  const env = herdrChildEnv()
  const child = children.get(name)
  const deadline = Date.now() + 5_000
  for (;;) {
    childProcess.spawnSync("herdr", ["session", "stop", name], { env, stdio: "ignore", timeout: 2_000 })
    const pid = livePid(child)
    if (pid !== undefined) killDetachedProcessGroup(pid)
    childProcess.spawnSync("herdr", ["session", "delete", name], { env, stdio: "ignore", timeout: 2_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const sessions = readSessions()
    if (sessions !== undefined && !sessions.some((session) => session.name === name) && livePid(child) === undefined) {
      started.delete(name)
      children.delete(name)
      return
    }
    if (Date.now() >= deadline) return
  }
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
