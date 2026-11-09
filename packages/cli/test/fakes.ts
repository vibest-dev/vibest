import net from "node:net"

import { readPing } from "@vibest/client/client"
import { Bus, type EngineEvent } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { Harness, Harnesses, HARNESS_IDS, HarnessUnavailable, type HarnessId } from "@vibest/core/harness"
import * as BuiltinHarnesses from "@vibest/core/harnesses"
import { VibestdIdentity } from "@vibest/core/identity"
import { Inbox } from "@vibest/core/inbox"
import { Machines, MachineTransport } from "@vibest/core/machines"
import { normalizeModels } from "@vibest/core/models"
import { Layout } from "@vibest/core/paths"
import { Peers } from "@vibest/core/peer"
import { type Candidate, Plugins } from "@vibest/core/plugins"
import { type Liveness, Processes } from "@vibest/core/processes"
import { Remote } from "@vibest/core/remote"
import { SshHosts } from "@vibest/core/repository-url"
import { Restarting } from "@vibest/core/restarting"
import { turnEndFrom } from "@vibest/core/results"
import { Runtimes, registry } from "@vibest/core/runtimes"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { systemPromptRoot } from "@vibest/core/system-prompt"
import type * as VibestPlugin from "@vibest/plugin"
import { harnessChoicePlugin } from "@vibest/plugin-harness-choice"
import { choicePlugin } from "@vibest/runtime-herdr/choice"
import { randomId } from "@vibest/schema/id"
import { readDaemonInfo } from "@vibest/server/daemon"
import {
  Clock,
  ConfigProvider,
  Context,
  Deferred,
  type Duration,
  Effect,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  type Predicate,
  PubSub,
  Ref,
  Schema,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { FakeGit } from "./fake-git.ts"
import { FakeRuntime, type FakeRuntimeOptions } from "./fake-runtime.ts"

export { FakeGit, FakeRuntime }

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

export const writeResult = (id: string, harness: string, payload: object, offsetMs = 1000) =>
  Effect.gen(function* () {
    const adapter = (yield* Harnesses).get(harness as HarnessId)
    const at = (yield* Clock.currentTimeMillis) + offsetMs
    yield* (yield* Db).reportTurn(id, turnEndFrom(adapter, payload as Record<string, unknown>, at))
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

export const eventsOf = (sessionId: string, type?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ id: number; type: string; at: number; data: string }>`SELECT id, type, at, data FROM event
      WHERE session_id = ${sessionId} ${type === undefined ? sql`` : sql`AND type = ${type}`} ORDER BY id`
    return rows.map((r) => ({ id: r.id, type: r.type, at: r.at, data: JSON.parse(r.data) as Record<string, unknown> }))
  }).pipe(Effect.orDie)

export const processEnds = (sessionId: string) =>
  eventsOf(sessionId, "process.end").pipe(Effect.map((rows) => rows.map((r) => r.data.reason)))

export const TURNS = `(SELECT t.id, t.session_id, t.at AS started_at, te.at AS ended_at, te.id AS end_id,
    (SELECT max(e.inbox_id) FROM event e WHERE e.turn_id = t.id AND e.type = 'inbox.status'
      AND json_extract(e.data, '$.to') = 'delivered') AS inbox_id,
    coalesce(json_extract(t.data, '$.typed'), (SELECT group_concat(c, char(10) || char(10)) FROM (SELECT i.content AS c
      FROM inbox i WHERE i.id IN (SELECT e.inbox_id FROM event e WHERE e.turn_id = t.id AND e.type = 'inbox.status'
        AND json_extract(e.data, '$.to') = 'delivered') ORDER BY i.id)), '') AS input,
    CASE WHEN te.id IS NULL THEN 'working' ELSE json_extract(te.data, '$.status') END AS status,
    (SELECT r.content FROM inbox r WHERE r.result_event_id = te.id) AS output
  FROM event t LEFT JOIN event te ON te.turn_id = t.id AND te.type = 'turn.end' WHERE t.type = 'turn.start')`

export const projectOf = (directory: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    return (yield* db.projectAt(directory))?.id ?? (yield* db.createProject(directory, []))
  })

export const tempDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix }))
  }).pipe(Effect.orDie)

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

export const makeRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* tempDirectory("vibest-repo-")
  yield* fs.writeFileString(path.join(root, "README.md"), "hi\n")
  yield* fs.writeFileString(path.join(root, "CLAUDE.md"), "local rules\n")
  yield* (yield* FakeGit).repository(root, { files: { "README.md": "hi\n" } })
  return root
}).pipe(Effect.orDie)

export class FakeProcesses extends Context.Service<
  FakeProcesses,
  {
    readonly set: (pid: number, liveness: Liveness) => Effect.Effect<void>
    readonly setCwdUsers: (users: ReadonlyArray<number> | undefined) => Effect.Effect<void>
    readonly probed: Effect.Effect<ReadonlyArray<number>>
    readonly signaled: Effect.Effect<ReadonlyArray<number>>
    readonly setSignalDenied: (denied: boolean) => Effect.Effect<void>
    readonly setSignalIgnored: (ignored: boolean) => Effect.Effect<void>
    readonly holdSignal: () => Effect.Effect<{
      readonly reached: Effect.Effect<void>
      readonly release: () => Effect.Effect<void>
    }>
    readonly holdCwd: () => Effect.Effect<{
      readonly reached: Effect.Effect<void>
      readonly release: () => Effect.Effect<void>
    }>
    readonly setCwdDelay: (delay: Duration.Input) => Effect.Effect<void>
    readonly cwdListings: Effect.Effect<number>
    readonly processes: Processes["Service"]
  }
>()("test/FakeProcesses") {
  static readonly layer = Layer.effect(
    FakeProcesses,
    Effect.gen(function* () {
      const states = yield* Ref.make(HashMap.empty<number, Liveness>())
      const users = yield* Ref.make<ReadonlyArray<number> | undefined>([])
      const cwdDelay = yield* Ref.make<Duration.Input>(0)
      const listings = yield* Ref.make(0)
      const probed = yield* Ref.make<ReadonlyArray<number>>([])
      const signaled = yield* Ref.make<ReadonlyArray<number>>([])
      const denied = yield* Ref.make(false)
      const ignored = yield* Ref.make(false)
      const signalGate = yield* Ref.make(
        Option.none<{ readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }>(),
      )
      const cwdGate = yield* Ref.make(
        Option.none<{ readonly reached: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }>(),
      )
      const holdNext = (gate: typeof cwdGate) =>
        Effect.gen(function* () {
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          yield* Ref.set(gate, Option.some({ reached, release }))
          return {
            reached: Deferred.await(reached),
            release: () => Deferred.succeed(release, undefined).pipe(Effect.asVoid),
          }
        })
      return FakeProcesses.of({
        set: (pid, liveness) => Ref.update(states, HashMap.set(pid, liveness)),
        setCwdUsers: (u) => Ref.set(users, u),
        cwdListings: Ref.get(listings),
        probed: Ref.get(probed),
        signaled: Ref.get(signaled),
        setSignalDenied: (d) => Ref.set(denied, d),
        setSignalIgnored: (i) => Ref.set(ignored, i),
        holdSignal: () => holdNext(signalGate),
        holdCwd: () => holdNext(cwdGate),
        setCwdDelay: (d) => Ref.set(cwdDelay, d),
        processes: Processes.of({
          liveness: (pid) =>
            Ref.update(probed, (p) => [...p, pid]).pipe(
              Effect.andThen(Ref.get(states)),
              Effect.map((m) => Option.getOrElse(HashMap.get(m, pid), (): Liveness => "exited")),
            ),
          terminate: (pid) =>
            Effect.gen(function* () {
              const gate = yield* Ref.modify(
                signalGate,
                (g) =>
                  [
                    g,
                    Option.none<{
                      readonly reached: Deferred.Deferred<void>
                      readonly release: Deferred.Deferred<void>
                    }>(),
                  ] as const,
              )
              if (Option.isSome(gate)) {
                yield* Deferred.succeed(gate.value.reached, undefined)
                yield* Deferred.await(gate.value.release)
                for (let i = 0; i < 8; i++) yield* Effect.yieldNow
              }
              if (yield* Ref.get(denied)) return "denied" as const
              yield* Ref.update(signaled, (s) => [...s, pid])
              if (!(yield* Ref.get(ignored))) yield* Ref.update(states, HashMap.set(pid, "exited" as Liveness))
              return "sent" as const
            }),
          cwdUsers: () =>
            Effect.gen(function* () {
              yield* Ref.update(listings, (n) => n + 1)
              const gate = yield* Ref.modify(
                cwdGate,
                (g) =>
                  [
                    g,
                    Option.none<{
                      readonly reached: Deferred.Deferred<void>
                      readonly release: Deferred.Deferred<void>
                    }>(),
                  ] as const,
              )
              if (Option.isSome(gate)) {
                yield* Deferred.succeed(gate.value.reached, undefined)
                yield* Deferred.await(gate.value.release)
              }
              yield* Effect.sleep(yield* Ref.get(cwdDelay))
              return yield* Ref.get(users)
            }),
        }),
      })
    }),
  )
}

export interface TestOptions extends FakeRuntimeOptions {
  readonly hooked?: ReadonlyArray<HarnessId>
  readonly unusable?: ReadonlyArray<HarnessId>
  readonly models?: ReadonlyArray<string>
  readonly maxSessions?: number
  readonly plugins?: ReadonlyArray<
    | VibestPlugin.Plugin.Plugin
    | { readonly plugin: VibestPlugin.Plugin.Plugin; readonly options?: Readonly<Record<string, unknown>> }
  >
  readonly pluginTimeout?: Duration.Input
  readonly sshHosts?: Readonly<Record<string, string>>
  readonly db?: (db: Db["Service"]) => Db["Service"]
  readonly missingBinary?: ReadonlyArray<HarnessId>
  readonly transport?: MachineTransport["Service"]
  readonly sessions?: (sessions: Sessions["Service"], db: Db["Service"]) => Sessions["Service"]
}

const noTransport: MachineTransport["Service"] = () => Effect.fail(new Error("no machine transport in this test"))

const harnessOf = (options: TestOptions) =>
  Layer.succeed(Harness, {
    available: (id) => Effect.succeed(!(options.missingBinary ?? []).includes(id)),
    plugin: (id) =>
      (options.hooked ?? HARNESS_IDS).includes(id)
        ? Effect.succeed(`/vibest/harnesses/${id}`)
        : Effect.fail(
            new HarnessUnavailable({
              harness: id,
              message: `vibest's ${id} plugin is missing: /vibest/harnesses/${id}`,
            }),
          ),
    models: (id, provider) =>
      options.unusable?.includes(id)
        ? Effect.fail(new HarnessUnavailable({ harness: id, message: "Not logged in" }))
        : Effect.succeed(
            normalizeModels(id, provider, [
              { model: "fake-model", default: true },
              ...["fake-strong", ...(options.models ?? [])].map((model) => ({ model, default: false })),
            ]),
          ),
  })

export const harnessChoice: Candidate = {
  source: "builtin:harness-choice",
  revision: "harness-choice",
  options: {},
  plugin: harnessChoicePlugin,
}

const over = (options: TestOptions) => {
  const runtime = Layer.effect(
    Runtimes,
    Effect.flatMap(FakeRuntime, (fake) => registry([fake.runtime])),
  )
  const home = Layer.effect(Layout, tempDirectory("vibest-home-").pipe(Effect.flatMap(Layout.make)))
  const ownTmpdir = Layer.unwrap(
    tempDirectory("vibest-tmp-").pipe(
      Effect.map((dir) =>
        ConfigProvider.layerAdd(ConfigProvider.fromEnv({ env: { TMPDIR: dir } }), { asPrimary: true }),
      ),
    ),
  )
  const plugins = Layer.effect(
    Plugins,
    Plugins.make(
      [
        harnessChoice,
        { source: "test:runtime-choice", revision: "-", options: {}, plugin: choicePlugin() },
        ...(options.plugins ?? []).map((entry) => {
          const plugin = "effect" in entry ? entry : entry.plugin
          const pluginOptions = "effect" in entry ? {} : (entry.options ?? {})
          return { source: `test:${plugin.id}`, revision: "-", options: pluginOptions, plugin }
        }),
      ],
      options.pluginTimeout ? { timeout: options.pluginTimeout } : {},
    ),
  ).pipe(Layer.provideMerge(Subscriptions.layer))
  const fakeIntegrationReportsReadyOnStart = Layer.effectDiscard(
    Effect.gen(function* () {
      const fake = yield* FakeRuntime
      const db = yield* Db
      let pid = 50_000
      yield* Ref.set(fake.onStarted, (session) =>
        Clock.currentTimeMillis.pipe(Effect.flatMap((at) => db.patchLive(session, { ready: at, pid: ++pid }))),
      )
    }),
  )
  return Layer.provideMerge(FakeRuntime.layer(options))(
    Layer.merge(Peers.layer, Remote.layer).pipe(
      Layer.provideMerge(
        Layer.effect(
          Sessions,
          Effect.flatMap(Sessions.make({ maxSessions: options.maxSessions }), (s) =>
            Effect.map(Db, (db) => (options.sessions ?? ((x) => x))(s, db)),
          ),
        ),
      ),
      Layer.provideMerge(
        Machines.layer.pipe(Layer.provide(Layer.succeed(MachineTransport, options.transport ?? noTransport))),
      ),
      Layer.provideMerge(fakeIntegrationReportsReadyOnStart),
      Layer.provideMerge(plugins),
      Layer.provideMerge(Inbox.layer),
      Layer.provideMerge(
        (options.db ? Layer.effect(Db, Effect.map(Db, options.db)).pipe(Layer.provide(Db.layer)) : Db.layer).pipe(
          Layer.provideMerge(Platform.sqlite(":memory:")),
        ),
      ),
      Layer.provideMerge(runtime),
      Layer.provideMerge(harnessOf(options)),
      Layer.provideMerge(BuiltinHarnesses.layer),
      Layer.provideMerge(
        Layer.effect(
          Processes,
          Effect.gen(function* () {
            return (yield* FakeProcesses).processes
          }),
        ).pipe(Layer.provideMerge(FakeProcesses.layer)),
      ),
      Layer.provideMerge(home),
      Layer.provideMerge(ownTmpdir),
      Layer.provideMerge(Drain.layer),
      Layer.provideMerge(Restarting.layer),
      Layer.provideMerge(FakeGit.layers),
      Layer.provideMerge(
        Layer.succeed(SshHosts, { hostName: (alias) => Effect.succeed(options.sshHosts?.[alias] ?? alias) }),
      ),
      Layer.provideMerge(Platform.services),
      Layer.provideMerge(Bus.layer),
      Layer.provideMerge(Layer.sync(VibestdIdentity, () => ({ id: randomId(), name: "test-host" }))),
    ),
  )
}

export const systemPromptFile = (id: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(yield* systemPromptRoot, id, "system-prompt.md")
  })

export const testLayer = (options: TestOptions = {}) => over(options)

export type TestServices = Layer.Success<ReturnType<typeof testLayer>> | FakeRuntime

export class GaveUp extends Schema.TaggedError<GaveUp>()("GaveUp", { helper: Schema.String }) {}

export const yieldToIo = TestClock.withLive(Effect.sleep("10 millis"))

const UNTIL_ATTEMPTS = 2000

const poll = <A, E, R, R2>(
  f: Effect.Effect<A, E, R>,
  done: Predicate.Predicate<A>,
  step: Effect.Effect<void, never, R2>,
  attempts: number,
  helper: string,
) =>
  f.pipe(
    Effect.tap((a) => (done(a) ? Effect.void : step)),
    Effect.repeat({ until: done, times: attempts }),
    Effect.filterOrFail(done, () => new GaveUp({ helper })),
  )

export function until<A, B extends A, E, R>(
  f: Effect.Effect<A, E, R>,
  done: Predicate.Refinement<A, B>,
): Effect.Effect<B, E | GaveUp, R>
export function until<A, E, R>(f: Effect.Effect<A, E, R>, done: Predicate.Predicate<A>): Effect.Effect<A, E | GaveUp, R>
export function until<A, E, R>(f: Effect.Effect<A, E, R>, done: Predicate.Predicate<A>) {
  return poll(f, done, yieldToIo, UNTIL_ATTEMPTS, "until")
}

export const settled = Effect.gen(function* () {
  const sessions = yield* Sessions
  yield* yieldToIo
  yield* until(sessions.inMemory, (m) => m.locks === 0)
})

export const untilVirtual = <A, E, R>(f: Effect.Effect<A, E, R>, done: Predicate.Predicate<A>) =>
  poll(f, done, yieldToIo.pipe(Effect.andThen(TestClock.adjust("100 millis"))), 1000, "untilVirtual")

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
