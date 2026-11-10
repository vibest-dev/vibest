import net from "node:net"

import { readPing } from "@vibest/client/client"
import { Bus, type EngineEvent } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { Git } from "@vibest/core/git"
import { Harness, Harnesses, HarnessUnavailable, makeHarnesses } from "@vibest/core/harness"
import type { HarnessDefinition, HarnessesShape, RuntimeDefinition, RuntimesShape } from "@vibest/core/host"
import { VibestdIdentity } from "@vibest/core/identity"
import { MachineTransport } from "@vibest/core/machines"
import { normalizeModels } from "@vibest/core/models"
import { Layout } from "@vibest/core/paths"
import { type Candidate, makeHost, Plugins } from "@vibest/core/plugins"
import { ProcessPlatform, Processes } from "@vibest/core/processes"
import { SshHosts } from "@vibest/core/repository-url"
import { turnEndFrom } from "@vibest/core/results"
import { HostEnv, make as makeRuntimes, Runtimes } from "@vibest/core/runtimes"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { systemPromptRoot } from "@vibest/core/system-prompt"
import { projectOf, tempDirectory } from "@vibest/core/test/lib/directory"
import { FakeProcesses } from "@vibest/core/test/lib/fake-processes"
import * as VibestPlugin from "@vibest/plugin"
import type { DaemonIdentity } from "@vibest/protocol/rpc"
import { choicePlugin } from "@vibest/runtime-herdr/choice"
import { randomId } from "@vibest/schema/id"
import * as App from "@vibest/server/app"
import { readDaemonInfo } from "@vibest/server/daemon"
import * as Server from "@vibest/server/server"
import {
  Clock,
  ConfigProvider,
  Context,
  Deferred,
  type Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  type Predicate,
  PubSub,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { FakeGit } from "./fake-git.ts"
import { FakeRuntime, type FakeRuntimeOptions, KIND } from "./fake-runtime.ts"

export { FakeGit, FakeProcesses, FakeRuntime, projectOf, tempDirectory }

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
    const adapter = yield* (yield* Harnesses).get(harness)
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

const noTransport: MachineTransport["Service"] = () => Effect.fail(new Error("no machine transport in this test"))

const opt = (flag: string, value: string | null) => (value ? [flag, value] : [])

const providerModel = (provider: string | null, model: string | null) =>
  model ? [...opt("--provider", provider), "--model", model] : []

export const PI: HarnessDefinition = {
  id: "pi",
  binary: "pi",
  ownSessionId: true,
  systemPromptInPrompt: false,
  interruptKey: "esc",
  resultField: "text",
  inbox: "subscribe",
  ready: "integration",
  launchArgs: (i) => [
    "--session-id",
    i.sessionId!,
    "--append-system-prompt",
    i.systemPromptFile,
    "-e",
    `${i.pluginDir}/extension.mjs`,
    ...providerModel(i.provider, i.model),
  ],
  coordinatorArgs: (i) => [
    ...opt("--session-id", i.sessionId),
    "--system-prompt",
    i.systemPromptFile,
    "-e",
    `${i.pluginDir}/extension.mjs`,
    ...providerModel(i.provider, i.model),
  ],
  models: { args: () => [], answer: () => undefined },
  turnEnd: (event, coordinator) =>
    coordinator || event.type !== "agent_settled"
      ? undefined
      : { result: { text: typeof event.text === "string" ? event.text : "", error: "", aborted: false } },
  userPrompt: (event, coordinator) =>
    coordinator || event.type !== "input" || typeof event.text !== "string" || event.text.trim() === ""
      ? undefined
      : { text: event.text },
}

const noProvider = (harness: string) => (provider: string | null) =>
  provider ? `${harness} has no provider option` : undefined

export const CLAUDE: HarnessDefinition = {
  id: "claude",
  binary: "claude",
  ownSessionId: true,
  systemPromptInPrompt: false,
  interruptKey: "esc",
  resultField: "last_assistant_message",
  inbox: "poll",
  ready: "integration",
  checkProvider: noProvider("claude"),
  launchArgs: (i) => [
    ...(i.resume ? ["--resume", i.sessionId!] : ["--session-id", i.sessionId!]),
    "--append-system-prompt-file",
    i.systemPromptFile,
    "--plugin-dir",
    i.pluginDir,
    ...opt("--model", i.model),
  ],
  coordinatorArgs: (i) => [
    ...opt("--resume", i.sessionId),
    "--append-system-prompt-file",
    i.systemPromptFile,
    "--plugin-dir",
    i.pluginDir,
    ...opt("--model", i.model),
  ],
  models: { args: () => [], answer: () => undefined },
  turnEnd: (event, coordinator) =>
    coordinator || event.hook_event_name !== "TurnComplete"
      ? undefined
      : {
          result:
            event.reason === "answer"
              ? event
              : event.reason === "aborted"
                ? {
                    ...event,
                    aborted: true,
                    error: "interrupted",
                    error_details: "the turn was stopped in its terminal (Esc) before it ended",
                  }
                : { ...event, error: "error", error_details: "the turn ended on an API error" },
        },
  userPrompt: (event, coordinator) =>
    coordinator || event.hook_event_name !== "PromptSubmit" || typeof event.text !== "string" || !event.text.trim()
      ? undefined
      : { text: event.text },
}

export const CURSOR: HarnessDefinition = {
  id: "cursor",
  binary: "cursor-agent",
  ownSessionId: false,
  systemPromptInPrompt: true,
  interruptKey: "ctrl+c",
  resultField: "text",
  ready: "runtime",
  checkProvider: noProvider("cursor"),
  launchArgs: (i) => [
    ...(i.resume && i.sessionId ? [`--resume=${i.sessionId}`] : []),
    "--plugin-dir",
    i.pluginDir,
    ...opt("--model", i.model),
  ],
  models: { args: () => [], answer: () => undefined },
  guardAnswer: (reason) =>
    reason ? { permission: "deny", user_message: reason, agent_message: reason } : { permission: "allow" },
  conversationOf: (event) => (typeof event.conversation_id === "string" ? event.conversation_id : undefined),
  turnEnd: (event, coordinator) =>
    !coordinator && event.hook_event_name === "afterAgentResponse" ? { result: event } : undefined,
  userPrompt: (event, coordinator) => {
    if (coordinator) return undefined
    if (event.hook_event_name === "afterAgentThought" || event.hook_event_name === "postToolUse") return { text: "" }
    return event.hook_event_name === "beforeSubmitPrompt" && typeof event.prompt === "string" && event.prompt.trim()
      ? { text: event.prompt }
      : undefined
  },
}

export const HARNESSES: ReadonlyArray<HarnessDefinition> = [PI, CLAUDE, CURSOR]

export const harnessesFrom = (
  definitions: ReadonlyArray<HarnessDefinition> = HARNESSES,
): Effect.Effect<HarnessesShape, never, Scope.Scope> =>
  Effect.tap(makeHarnesses, (harnesses) =>
    harnesses.transform((editor) => definitions.forEach((definition) => editor.add(definition))),
  )

export const noHostEnv = Layer.succeed(HostEnv, { drop: () => {} })

export const processesOn = (platform: ProcessPlatform["Service"]) =>
  Processes.layer.pipe(Layer.provide(Layer.succeed(ProcessPlatform, platform)))

export const runtimesLayer = Runtimes.layer.pipe(Layer.provide(noHostEnv))

export const harnessesLayer = (definitions: ReadonlyArray<HarnessDefinition> = HARNESSES) =>
  Layer.effect(Harnesses, harnessesFrom(definitions))

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

export const runtimesFrom = (
  definitions: ReadonlyArray<RuntimeDefinition>,
): Effect.Effect<RuntimesShape, never, Bus | HostEnv | Scope.Scope> =>
  Effect.tap(makeRuntimes, (runtimes) =>
    runtimes.transform((editor) => definitions.forEach((definition) => editor.add(definition))),
  )

const harnessOf = (options: TestOptions) =>
  Layer.succeed(Harness, {
    available: (id) => Effect.succeed(!(options.missingBinary ?? []).includes(id)),
    plugin: (id) =>
      (options.hooked ?? (options.harnesses ?? HARNESSES).map((h) => h.id)).includes(id)
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

export const subscriptionsLayer = Subscriptions.testLayer.pipe(Layer.provide(harnessOf({})))

type PluginEntry = NonNullable<TestOptions["plugins"]>[number]

const candidateOf = (entry: PluginEntry): Candidate => {
  const plugin = "effect" in entry ? entry : entry.plugin
  const pluginOptions = "effect" in entry ? {} : (entry.options ?? {})
  return { source: `test:${plugin.id}`, revision: "-", options: pluginOptions, plugin }
}

export class PluginHost extends Context.Service<
  PluginHost,
  { readonly load: (added: ReadonlyArray<PluginEntry>) => Effect.Effect<void> }
>()("test/PluginHost") {}

const over = (options: TestOptions) => {
  const platform = LayerNode.make({ name: "test/Platform", layer: Platform.services, deps: [] })
  const home = LayerNode.make({
    service: Layout,
    layer: Layer.effect(Layout, tempDirectory("vibest-home-").pipe(Effect.flatMap(Layout.make))),
    deps: [platform],
  })
  const ownTmpdir = LayerNode.make({
    name: "test/Tmpdir",
    layer: Layer.unwrap(
      tempDirectory("vibest-tmp-").pipe(
        Effect.map((dir) =>
          ConfigProvider.layerAdd(ConfigProvider.fromEnv({ env: { TMPDIR: dir } }), { asPrimary: true }),
        ),
      ),
    ),
    deps: [platform],
  })
  const fakeRuntime = LayerNode.make({ service: FakeRuntime, layer: FakeRuntime.layer(options), deps: [platform] })
  const runtimes = LayerNode.make({
    service: Runtimes,
    layer: Layer.effect(
      Runtimes,
      Effect.flatMap(FakeRuntime, (fake) => runtimesFrom([fake.runtime])),
    ),
    deps: [fakeRuntime, Bus.node, HostEnv.node],
  })
  const fakeProcesses = LayerNode.make({ service: FakeProcesses, layer: FakeProcesses.layer, deps: [] })
  const processes = LayerNode.make({
    service: Processes,
    layer: Layer.effect(
      Processes,
      Effect.gen(function* () {
        return (yield* FakeProcesses).processes
      }),
    ),
    deps: [fakeProcesses],
  })
  const fakeGit = LayerNode.make({ name: "test/FakeGit", layer: FakeGit.layers, deps: [platform] })
  const subscriptions = LayerNode.make({
    service: Subscriptions,
    layer: Subscriptions.testLayer,
    deps: [Harness.node, Harnesses.node],
  })
  const candidates: ReadonlyArray<Candidate> = [
    { source: "test:runtime-choice", revision: "-", options: {}, plugin: choicePlugin() },
    ...(options.plugins ?? []).map(candidateOf),
  ]
  const plugins = LayerNode.make({
    name: "test/Plugins",
    layer: Layer.effectContext(
      Effect.gen(function* () {
        const host = yield* makeHost(options.pluginTimeout ? { timeout: options.pluginTimeout } : {})
        if (options.activateLate) {
          host.ready.closeUnsafe()
          yield* host.activate(candidates).pipe(Effect.andThen(host.ready.open), Effect.forkScoped)
        } else yield* host.activate(candidates)
        return Context.make(Plugins, host.service).pipe(
          Context.add(PluginHost, {
            load: (added) => host.activate([...candidates, ...added.map(candidateOf)]),
          }),
        )
      }),
    ),
    deps: [Harnesses.node, Runtimes.node, Subscriptions.node, platform, home],
  })
  const fakeIntegrationReportsReadyOnStart = LayerNode.make({
    name: "test/IntegrationReadyOnStart",
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const fake = yield* FakeRuntime
        const db = yield* Db
        let pid = 50_000
        yield* Ref.set(fake.onStarted, (session) =>
          Clock.currentTimeMillis.pipe(Effect.flatMap((at) => db.patchLive(session, { ready: at, pid: ++pid }))),
        )
      }),
    ),
    deps: [fakeRuntime, Db.node],
  })
  const configured = Sessions.configured({ maxSessions: options.maxSessions })
  const decorate = options.sessions
  const sessions =
    decorate === undefined
      ? configured
      : LayerNode.make({
          service: Sessions,
          layer: Layer.effect(
            Sessions,
            Effect.gen(function* () {
              return decorate(yield* Sessions, yield* Db)
            }),
          ),
          deps: [configured, Db.node],
        })
  const decorateDb = options.db
  const replacements: LayerNode.Replacements = [
    PlatformNode.fileSystem.replace(platform),
    PlatformNode.path.replace(platform),
    PlatformNode.crypto.replace(platform),
    PlatformNode.childProcessSpawner.replace(platform),
    PlatformNode.layout.replace(home),
    PlatformNode.sqlClient.replace(Platform.sqlite(":memory:")),
    Runtimes.node.replace(runtimes),
    Harness.node.replace(harnessOf(options)),
    Harnesses.node.replace(harnessesLayer(options.harnesses)),
    Processes.node.replace(processes),
    Git.node.replace(fakeGit),
    SshHosts.node.replace(
      Layer.succeed(SshHosts, { hostName: (alias) => Effect.succeed(options.sshHosts?.[alias] ?? alias) }),
    ),
    Subscriptions.node.replace(subscriptions),
    Plugins.node.replace(plugins),
    Sessions.node.replace(sessions),
    ...(decorateDb === undefined
      ? []
      : [
          Db.node.replace(
            Db.node.mapLayer((layer) => Layer.effect(Db, Effect.map(Db, decorateDb)).pipe(Layer.provide(layer))),
          ),
        ]),
    MachineTransport.node.replace(Layer.succeed(MachineTransport, options.transport ?? noTransport)),
    HostEnv.node.replace(noHostEnv),
    VibestdIdentity.node.replace(Layer.sync(VibestdIdentity, () => ({ id: randomId(), name: "test-host" }))),
    Server.Identity.node.replace(Layer.succeed(Server.Identity, options.identity ?? {})),
    Server.Shutdown.node.replace(Layer.effect(Server.Shutdown, Deferred.make<void>())),
  ]
  return LayerNode.compile(
    LayerNode.group([
      ownTmpdir,
      platform,
      home,
      PlatformNode.sqlClient,
      HostEnv.node,
      VibestdIdentity.node,
      Server.Identity.node,
      Server.Shutdown.node,
      fakeProcesses,
      Processes.node,
      fakeGit,
      fakeRuntime,
      App.services,
      plugins,
      fakeIntegrationReportsReadyOnStart,
    ]),
    { replacements },
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

const isTestClock = (clock: Clock.Clock): clock is TestClock.TestClock => "withLive" in clock

const ioPause = Effect.sleep("10 millis")

export const yieldToIo = Clock.clockWith((clock) => (isTestClock(clock) ? clock.withLive(ioPause) : ioPause))

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
