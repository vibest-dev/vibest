import net from "node:net"

import { readPing } from "@vibest/client/client"
import { Bus, type EngineEvent } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { Harness, Harnesses } from "@vibest/core/harness"
import type { HarnessDefinition } from "@vibest/core/host"
import { MachineTransport } from "@vibest/core/machines"
import { Layout } from "@vibest/core/paths"
import { ProcessPlatform, Processes } from "@vibest/core/processes"
import { SshHosts } from "@vibest/core/repository-url"
import { Sessions } from "@vibest/core/sessions"
import { systemPromptRoot } from "@vibest/core/system-prompt"
import { projectOf, tempDirectory } from "@vibest/core/test/lib/directory"
import { FakeProcesses } from "@vibest/core/test/lib/fake-processes"
import {
  CLAUDE,
  CURSOR,
  HARNESSES,
  PI,
  harnessLayer,
  harnessesLayer,
  runtimesLayer,
  subscriptionsLayer,
} from "@vibest/core/test/lib/harnesses"
import { eventsOf as readEvents } from "@vibest/core/test/lib/observe"
import {
  dbReplacement,
  pluginsHost,
  runtimeNode,
  sessionLayer,
  sessionsNode,
  sshHosts,
  transportLayer,
} from "@vibest/core/test/lib/session"
import * as VibestPlugin from "@vibest/plugin"
import type { DaemonIdentity } from "@vibest/protocol/rpc"
import { readDaemonInfo } from "@vibest/server/daemon"
import * as Server from "@vibest/server/server"
import { type Duration, Effect, FileSystem, Layer, Option, Path, PubSub, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"

import * as Platform from "#platform"

import { FakeGit } from "./fake-git.ts"
import { FakeRuntime, type FakeRuntimeOptions, KIND } from "./fake-runtime.ts"

export {
  CLAUDE,
  CURSOR,
  FakeGit,
  FakeProcesses,
  FakeRuntime,
  HARNESSES,
  PI,
  harnessesLayer,
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
          (prop === "Spawn" ||
            prop === "Launch" ||
            prop === "Project.CoordinatorSession" ||
            prop === "Project.RunningCoordinator")
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

export const resultText = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ text: string | null }>`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM event te WHERE te.type = 'turn.end' AND json_extract(te.data, '$.report') = r.id)
      THEN NULL ELSE json_extract(r.data, '$.text') END AS text
      FROM event r WHERE r.session_id = ${id} AND r.type = 'turn.reported' ORDER BY r.id DESC LIMIT 1`.pipe(
      Effect.orDie,
    )
    return row?.text ?? ""
  })

export const busEvents = Effect.gen(function* () {
  return yield* (yield* Bus).subscribe
})

export const nextTurnStart = (subscription: PubSub.Subscription<EngineEvent>, id: string): Effect.Effect<number> =>
  PubSub.take(subscription).pipe(
    Effect.flatMap((event) =>
      event.type === "live.turn_start" && event.sessionId === id
        ? Effect.succeed(event.at)
        : nextTurnStart(subscription, id),
    ),
  )

export const savedSession = (sessionId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const projectId = yield* db.projectOfSession(sessionId)
    if (projectId === undefined) return null
    const main = yield* db.coordinatorOf(projectId)
    return main?.id === sessionId ? main.harnessSessionId : null
  })

export const processEnds = (sessionId: string) =>
  readEvents(sessionId, "process.end").pipe(Effect.map((rows) => rows.map((r) => r.data.reason)))

export const TURNS = `(SELECT t.id, t.session_id, t.at AS started_at, te.at AS ended_at, te.id AS end_id,
    (SELECT max(e.inbox_id) FROM event e WHERE e.turn_id = t.id AND e.type = 'inbox.status'
      AND json_extract(e.data, '$.to') = 'delivered') AS inbox_id,
    coalesce(json_extract(t.data, '$.typed'), (SELECT group_concat(c, char(10) || char(10)) FROM (SELECT i.content AS c
      FROM inbox i WHERE i.id IN (SELECT e.inbox_id FROM event e WHERE e.turn_id = t.id AND e.type = 'inbox.status'
        AND json_extract(e.data, '$.to') = 'delivered') ORDER BY i.id)), '') AS input,
    CASE WHEN te.id IS NULL THEN 'working' ELSE json_extract(te.data, '$.status') END AS status,
    (SELECT r.content FROM inbox r WHERE r.result_event_id = te.id) AS output
  FROM event t LEFT JOIN event te ON te.turn_id = t.id AND te.type = 'turn.end' WHERE t.type = 'turn.start')`

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
    const text = (s: Stream.Stream<Uint8Array, unknown>) => Stream.mkString(Stream.decodeText(s))
    const [stdout, stderr, code] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], {
      concurrency: 3,
    })
    return { stdout, stderr, code }
  }).pipe(Effect.scoped, Effect.orDie)

export interface TestOptions extends FakeRuntimeOptions {
  readonly hooked?: ReadonlyArray<string>
  readonly unusable?: ReadonlyArray<string>
  readonly models?: ReadonlyArray<string>
  readonly maxSessions?: number
  readonly plugins?: ReadonlyArray<
    | VibestPlugin.Plugin.Plugin
    | { readonly plugin: VibestPlugin.Plugin.Plugin; readonly options?: Readonly<Record<string, unknown>> }
  >
  readonly pluginTimeout?: Duration.Input
  readonly activateLate?: boolean
  readonly db?: (db: Db["Service"]) => Db["Service"]
  readonly missingBinary?: ReadonlyArray<string>
  readonly harnesses?: ReadonlyArray<HarnessDefinition>
  readonly sshHosts?: Readonly<Record<string, string>>
  readonly transport?: MachineTransport["Service"]
  readonly sessions?: (sessions: Sessions["Service"], db: Db["Service"]) => Sessions["Service"]
  readonly identity?: DaemonIdentity
}

export const processesOn = (platform: ProcessPlatform["Service"]) =>
  Processes.layer.pipe(Layer.provide(Layer.succeed(ProcessPlatform, platform)))

export const callerPlugin = (id: string, caller: VibestPlugin.Runtime.RuntimeCaller) =>
  VibestPlugin.Plugin.define({
    id: `runtime-${id}-caller`,
    effect: (context) =>
      context.runtime
        .transform((editor) => {
          const own = editor.get(id)
          if (own === undefined) editor.add({ ...editor.get(KIND)!, id, caller })
          else editor.update(id, (definition) => (definition.caller = caller))
        })
        .pipe(Effect.asVoid),
  })

export { makeRepository, PluginHost, type PluginEntry } from "@vibest/core/test/lib/session"
export { GaveUp, eventsOf, settled, until, untilVirtual, writeResult, yieldToIo } from "@vibest/core/test/lib/observe"

export const testLayer = (options: TestOptions = {}) =>
  sessionLayer(
    [
      runtimeNode.replace(FakeRuntime.layer(options)),
      Harness.node.replace(harnessLayer(harnessStandIn(options))),
      Harnesses.node.replace(harnessesLayer(options.harnesses)),
      Sessions.node.replace(sessionsNode(options.maxSessions, options.sessions)),
      ...(options.db === undefined ? [] : [dbReplacement(options.db)]),
      SshHosts.node.replace(sshHosts(options.sshHosts)),
      MachineTransport.node.replace(transportLayer(options.transport)),
      ...(options.identity === undefined
        ? []
        : [Server.Identity.node.replace(Layer.succeed(Server.Identity, options.identity))]),
    ],
    pluginsHost(options.plugins ?? [], {
      ...(options.pluginTimeout === undefined ? {} : { timeout: options.pluginTimeout }),
      ...(options.activateLate === undefined ? {} : { activateLate: options.activateLate }),
    }),
  )

const harnessStandIn = (options: TestOptions) => ({
  ...(options.hooked === undefined ? {} : { hooked: options.hooked }),
  ...(options.unusable === undefined ? {} : { unusable: options.unusable }),
  ...(options.models === undefined ? {} : { models: options.models }),
  ...(options.missingBinary === undefined ? {} : { missingBinary: options.missingBinary }),
  ...(options.harnesses === undefined ? {} : { harnesses: options.harnesses }),
})

export const systemPromptFile = (id: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(yield* systemPromptRoot, id, "system-prompt.md")
  })

export type TestServices = Layer.Success<ReturnType<typeof testLayer>> | FakeRuntime

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

export const stopRecorded = (daemonInfo: string) =>
  Effect.gen(function* () {
    const running = Option.getOrUndefined(yield* readDaemonInfo(daemonInfo))
    if (!running) return
    yield* Effect.try(() => process.kill(running.pid, "SIGTERM")).pipe(Effect.ignore)
    yield* Effect.sleep("100 millis").pipe(
      Effect.repeat({ until: () => Platform.liveness(running.pid) === "exited", times: 100 }),
    )
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
