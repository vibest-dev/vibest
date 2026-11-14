import net from "node:net"

import { readPing } from "@vibest/client/client"
import { App } from "@vibest/core/app"
import { Db } from "@vibest/core/database/db"
import { ProcessPlatform, Processes } from "@vibest/core/processes"
import { agentsLayer } from "@vibest/core/test/lib/agents"
import { entryPending, projectOf, tempDirectory } from "@vibest/core/test/lib/directory"
import { FakeProcesses } from "@vibest/core/test/lib/fake-processes"
import {
  CLAUDE,
  CURSOR,
  HARNESSES,
  PI,
  harnessesLayer,
  runtimesLayer,
  subscriptionsLayer,
} from "@vibest/core/test/lib/harnesses"
import { NOT_CHECKED } from "@vibest/protocol/rpc"
import { Layout } from "@vibest/schema/layout"
import { readDaemonInfo } from "@vibest/server/daemon"
import { UpdateCheck } from "@vibest/server/update-check"
import { Effect, FileSystem, Layer, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

import { commandOf, note } from "../../../tools/reap.ts"
import { VERSION } from "../src/version.ts"
import { FakeGit } from "./fake-git.ts"
import { FakeRuntime } from "./fake-runtime.ts"

export {
  agentsLayer,
  CLAUDE,
  CURSOR,
  FakeGit,
  FakeProcesses,
  FakeRuntime,
  HARNESSES,
  PI,
  harnessesLayer,
  entryPending,
  projectOf,
  runtimesLayer,
  subscriptionsLayer,
  tempDirectory,
}

export const TEST_HERDR = "herdr"

export const authed = <C extends object>(client: C, headers: Record<string, string>): C =>
  new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== "function") return value
      return (input: unknown, options?: { headers?: Record<string, string> }) => {
        const payload =
          input !== null &&
          typeof input === "object" &&
          !Array.isArray(input) &&
          !("runtime" in input) &&
          (prop === "Spawn" || prop === "Launch" || prop === "Project.EntrySession" || prop === "Project.RunningEntry")
            ? { ...input, runtime: TEST_HERDR }
            : input
        return (value as (payload: unknown, options?: { headers?: Record<string, string> }) => unknown).call(
          target,
          payload,
          { ...options, headers: { ...headers, ...options?.headers } },
        )
      }
    },
  })

export const savedSession = (sessionId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const projectId = yield* db.projectOfSession(sessionId)
    if (projectId === undefined) return null
    const entry = yield* db.entryOf(projectId)
    return entry?.id === sessionId ? (entry.process?.conversation ?? null) : null
  })

const STDIN_FROM_FILE = 'f=$1; shift; exec "$@" <"$f"'

export const withStdin = (input: string, command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = `${yield* tempDirectory("vibest-stdin-")}/stdin`
    yield* fs.writeFileString(file, input).pipe(Effect.orDie)
    return ["-c", STDIN_FROM_FILE, "sh", file, command, ...args] as const
  })

export const PATH_WITHOUT_HARNESS_CLIS = "/usr/bin:/bin"

const mainTs = `${import.meta.dirname}/../src/main.ts`

export const noteRecorded = (daemonInfo: string) =>
  Effect.gen(function* () {
    const running = Option.getOrUndefined(yield* readDaemonInfo(daemonInfo))
    if (!running) return
    const live = commandOf(running.pid).trim()
    if (!live.includes("daemon --foreground")) return
    const recorded = running.command ?? []
    const marker = recorded.length > 0 && recorded.every((part) => live.includes(part)) ? recorded.join(" ") : live
    if (marker === "" || /[\t\n]/.test(marker)) return
    note(running.pid, marker)
  }).pipe(Effect.ignore)

export const runVibest = (cwd: string, env: Record<string, string>, args: ReadonlyArray<string>, stdin = "") =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make("sh", yield* withStdin(stdin, process.execPath, [mainTs, ...args]), {
        cwd,
        env: { PATH: PATH_WITHOUT_HARNESS_CLIS, ...env },
        extendEnv: false,
        stdin: "ignore",
      }),
    )
    if (args[0] === "daemon") note(Number(handle.pid), mainTs)
    const text = (s: Stream.Stream<Uint8Array, unknown>) => Stream.mkString(Stream.decodeText(s))
    const [stdout, stderr, code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], {
      concurrency: 3,
    })
    if (env.VIBEST_HOME !== undefined) yield* noteRecorded(`${env.VIBEST_HOME}/vibestd.pid`)
    return { stdout, stderr, code }
  }).pipe(Effect.scoped, Effect.orDie)

export const processesOn = (platform: ProcessPlatform["Service"]) =>
  Processes.layer.pipe(Layer.provide(Layer.succeed(ProcessPlatform, platform)))

export {
  makeRepository,
  restartSessions,
  PluginHost,
  callerPlugin,
  type PluginEntry,
  type TestServices,
} from "@vibest/core/test/lib/session"
import { sessionFrom, type TestOptions } from "@vibest/core/test/lib/session"

export type { TestOptions }
export {
  GaveUp,
  EXECUTIONS,
  eventsOf,
  processEnds,
  replyText,
  settled,
  systemPromptFile,
  until,
  untilVirtual,
  writeEnd,
  yieldToIo,
} from "@vibest/core/test/lib/observe"

export const pingOf = (socket: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 40; attempt++) {
      const ping = yield* readPing(socket)
      if (Option.isSome(ping)) return ping.value
      yield* Effect.sleep("250 millis")
    }
    return yield* Effect.die(new Error(`no Ping answer on ${socket}`))
  })

export const recordedInfo = (daemonInfo: string, instance: string | undefined) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const info = yield* readDaemonInfo(daemonInfo)
      if (Option.isSome(info) && info.value.instance === instance) return info.value
      yield* Effect.sleep("50 millis")
    }
    return yield* Effect.die(new Error(`${daemonInfo} never recorded vibestd ${instance}`))
  })

const endDaemonPid = async (pid: number) => {
  try {
    process.kill(pid, "SIGTERM")
  } catch (e) {
    if (!(e instanceof Error) || !("code" in e) || e.code !== "ESRCH") throw e
    return
  }
  for (const deadline = Date.now() + 2_000; Platform.liveness(pid) !== "exited" && Date.now() < deadline;)
    await new Promise((resolve) => setTimeout(resolve, 50))
  if (Platform.liveness(pid) === "exited") return
  try {
    process.kill(pid, "SIGKILL")
  } catch (e) {
    if (!(e instanceof Error) || !("code" in e) || e.code !== "ESRCH") throw e
  }
}

const ours = (pid: number, recorded: ReadonlyArray<string> | undefined) => {
  const live = commandOf(pid)
  if (!live.includes("daemon --foreground")) return false
  if (recorded !== undefined && recorded.every((part) => live.includes(part))) return true
  return live.includes(mainTs)
}

export const stopRecorded = (daemonInfo: string) =>
  Effect.gen(function* () {
    yield* noteRecorded(daemonInfo)
    const running = Option.getOrUndefined(yield* readDaemonInfo(daemonInfo))
    if (!running || !ours(running.pid, running.command)) return
    yield* Effect.promise(() => endDaemonPid(running.pid))
  }).pipe(Effect.ignore)

export type Line = Record<string, unknown>

export interface Wire {
  readonly send: (message: Line) => Effect.Effect<void>
  readonly recv: Effect.Effect<Line>
  readonly lines: Array<Line>
}

export const wire = Effect.gen(function* () {
  const layout = yield* Layout
  const lines: Array<Line> = []
  const received: Array<Line> = []
  const waiting: Array<(line: Line) => void> = []
  const conn = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<net.Socket>((resolve, reject) => {
          const socket = net.createConnection(layout.socket)
          let buffer = ""
          socket.setEncoding("utf8")
          socket.on("data", (chunk: string) => {
            buffer += chunk
            for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
              const text = buffer.slice(0, end)
              buffer = buffer.slice(end + 1)
              if (text === "") continue
              const line = JSON.parse(text) as Line
              const waiter = waiting.shift()
              if (waiter) waiter(line)
              else received.push(line)
            }
          })
          socket.once("connect", () => resolve(socket))
          socket.once("error", reject)
        }),
    ),
    (socket) => Effect.sync(() => socket.destroy()),
  )
  return {
    lines,
    send: (message) =>
      Effect.sync(() => {
        lines.push(message)
        conn.write(`${JSON.stringify(message)}\n`)
      }),
    recv: Effect.promise(
      () => new Promise<Line>((resolve) => (received.length > 0 ? resolve(received.shift()!) : waiting.push(resolve))),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.orDie,
      Effect.tap((line) => Effect.sync(() => lines.push(line))),
    ),
  } satisfies Wire
})

export const hostReplacements = [
  App.node.replace(Layer.succeed(App, { version: VERSION })),
  UpdateCheck.node.replace(Layer.succeed(UpdateCheck, Effect.succeed(NOT_CHECKED))),
]

export const testLayer = (options: TestOptions = {}) => sessionFrom({ version: VERSION, ...options })
