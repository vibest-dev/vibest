import { Agents } from "@vibest/core/agent/registry"
import { App } from "@vibest/core/app"
import { Bus } from "@vibest/core/bus"
import { Database } from "@vibest/core/database/database"
import { PlatformNode } from "@vibest/core/effect/platform"
import { Harness } from "@vibest/core/harness"
import { Harnesses } from "@vibest/core/harness/registry"
import { Subscriptions } from "@vibest/core/harness/subscriptions"
import { Identity } from "@vibest/core/identity"
import { Inbox } from "@vibest/core/inbox"
import { InboxStore } from "@vibest/core/inbox/store"
import { Mcp } from "@vibest/core/mcp"
import { type Candidate, makeHost, Plugins } from "@vibest/core/plugin"
import type { HarnessDefinition, RuntimeDefinition } from "@vibest/core/plugin/domains"
import { Hooks } from "@vibest/core/plugin/hooks"
import { RepositoryUrl } from "@vibest/core/project/repository-url"
import { ProjectStore } from "@vibest/core/project/store"
import { RemoteStore } from "@vibest/core/remote/store"
import { Drain } from "@vibest/core/runtime/drain"
import { Processes } from "@vibest/core/runtime/processes"
import { Runtimes, make as makeRuntimes } from "@vibest/core/runtime/registry"
import { Session } from "@vibest/core/session"
import { Archive } from "@vibest/core/session/archive"
import { SessionLive } from "@vibest/core/session/live"
import { Sends } from "@vibest/core/session/sends"
import { SessionStore } from "@vibest/core/session/store"
import { Summaries } from "@vibest/core/session/summaries"
import { Git } from "@vibest/core/worktree/git"
import { McpRuntime } from "@vibest/mcp/service"
import { agentPlugin } from "@vibest/plugin-builtins/agent"
import { guardPlugin } from "@vibest/plugin-builtins/guard"
import { runtimeChoicePlugin } from "@vibest/plugin-builtins/runtime-choice"
import * as VibestPlugin from "@vibest/plugin/effect"
import { NOT_CHECKED, type DaemonIdentity } from "@vibest/protocol/schemas"
import { randomId } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import { DaemonHandlers } from "@vibest/server/handlers/daemon"
import { Load } from "@vibest/server/machine/load"
import { Machines } from "@vibest/server/machine/machines"
import { services } from "@vibest/server/services"
import { UpdateCheck } from "@vibest/server/update-check"
import { LayerNode } from "@vibest/util/layer-node"
import {
  Clock,
  ConfigProvider,
  Context,
  Deferred,
  type Duration,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  type Schema,
  Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"

import { services as platformServices } from "./bun.ts"
import { tempDirectory } from "./directory.ts"
import { FakeGit } from "./fake-git.ts"
import { FakeRuntime, type FakeRuntimeOptions } from "./fake-runtime.ts"
import { harnessLayer, harnessesLayer, noHostEnv } from "./harnesses.ts"
import { compile, fakeGit, fakeProcesses, fakeRuntime, platform } from "./layers.ts"

export const runtimeNode = fakeRuntime()

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

const runtimesFrom = (definitions: ReadonlyArray<RuntimeDefinition>) =>
  Effect.tap(makeRuntimes, (runtimes) =>
    runtimes.transform((editor) => definitions.forEach((definition) => editor.add(definition))),
  )

const runtimes = LayerNode.make({
  service: Runtimes.Service,
  layer: Layer.effect(
    Runtimes.Service,
    Effect.flatMap(FakeRuntime, (fake) => runtimesFrom([fake.runtime])),
  ),
  deps: [runtimeNode, Bus.node, Runtimes.hostEnvNode, Runtimes.terminalProcessesNode],
})

const subscriptions = LayerNode.make({
  service: Subscriptions.Service,
  layer: Subscriptions.testLayer,
  deps: [Harness.node, Harnesses.node],
})

export type PluginEntry =
  | VibestPlugin.Plugin.Plugin
  | { readonly plugin: VibestPlugin.Plugin.Plugin; readonly options?: Schema.JsonObject }

const candidateOf = (entry: PluginEntry): Candidate => {
  const plugin = "plugin" in entry ? entry.plugin : entry
  const pluginOptions = "plugin" in entry ? (entry.options ?? {}) : {}

  return { source: `test:${plugin.id}`, revision: "-", options: pluginOptions, plugin }
}

export class PluginHost extends Context.Service<
  PluginHost,
  { readonly load: (added: ReadonlyArray<PluginEntry>) => Effect.Effect<void> }
>()("test/PluginHost") {}

export const pluginsHost = (
  added: ReadonlyArray<PluginEntry> = [],
  options: { readonly timeout?: Duration.Input; readonly activateLate?: boolean } = {},
) => {
  const loaded: ReadonlyArray<Candidate> = [
    { source: "test:agent", revision: "-", options: {}, plugin: agentPlugin },
    { source: "test:guard", revision: "-", options: {}, plugin: guardPlugin },
    { source: "test:vibest.runtime-choice", revision: "-", options: {}, plugin: runtimeChoicePlugin() },
    ...added.map(candidateOf),
  ]

  return LayerNode.make({
    name: "test/Plugins",
    layer: Layer.effectContext(
      Effect.gen(function* () {
        const host = yield* makeHost(options.timeout === undefined ? {} : { timeout: options.timeout })

        if (options.activateLate) {
          const release = host.holdNow()
          yield* host.activate(loaded).pipe(Effect.andThen(release), Effect.forkScoped)
        } else yield* host.activate(loaded)

        return Context.make(Plugins.Service, host.service).pipe(
          Context.add(PluginHost, {
            load: (added) => host.activate([...loaded, ...added.map(candidateOf)]),
          }),
        )
      }),
    ),
    deps: [
      Agents.node,
      Archive.node,
      Bus.node,
      Database.node,
      ProjectStore.node,
      SessionStore.node,
      InboxStore.node,
      RemoteStore.node,
      Harnesses.node,
      Hooks.node,
      Runtimes.node,
      Sends.node,
      SessionLive.node,
      Subscriptions.node,
      Summaries.node,
      platform,
      home,
    ],
  })
}

const readyOnStart = LayerNode.make({
  name: "test/IntegrationReadyOnStart",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const fake = yield* FakeRuntime
      const sessionStore = yield* SessionStore.Service
      const harnesses = yield* Harnesses.Service
      let pid = 50_000
      yield* Ref.set(fake.onStarted, (session, launch) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          yield* sessionStore.patchLive(session, { ready: at, pid: ++pid })
          const raw = launch?.working ? launch.env.VIBEST_EXECUTION : undefined
          const execution = raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined
          const harness = launch?.env.VIBEST_HARNESS

          if (execution !== undefined && harness !== undefined && harnesses.find(harness)?.ready === "integration")
            if (yield* sessionStore.acceptExecution(session, execution))
              yield* sessionStore.setStatus(session, "working")
        }),
      )
    }),
  ),
  deps: [runtimeNode, SessionStore.node, Harnesses.node],
})

const noTransport: Machines.MachineTransport["Service"] = () =>
  Effect.fail(new Error("no machine transport in this test"))

const defaultSsh = Layer.succeed(RepositoryUrl.Service, { hostName: (alias) => Effect.succeed(alias) })

const defaultTransport = Layer.succeed(Machines.MachineTransport, noTransport)

const sessionsDecorated = (
  decorate: (sessions: Session.Interface, sessionStore: SessionStore.Interface) => Session.Interface,
) =>
  Session.node.replace(
    LayerNode.make({
      service: Session.Service,
      layer: Layer.effect(
        Session.Service,
        Effect.gen(function* () {
          return decorate(yield* Session.make, yield* SessionStore.Service)
        }),
      ),
      deps: Session.deps,
    }),
  )

export const sessionStoreReplacement = (decorate: (store: SessionStore.Interface) => SessionStore.Interface) =>
  SessionStore.node.replace(
    SessionStore.node.mapLayer((layer) =>
      Layer.effect(SessionStore.Service, Effect.map(SessionStore.Service, decorate)).pipe(Layer.provide(layer)),
    ),
  )

export const inboxStoreReplacement = (decorate: (store: InboxStore.Interface) => InboxStore.Interface) =>
  InboxStore.node.replace(
    InboxStore.node.mapLayer((layer) =>
      Layer.effect(InboxStore.Service, Effect.map(InboxStore.Service, decorate)).pipe(Layer.provide(layer)),
    ),
  )

export const remoteStoreReplacement = (decorate: (store: RemoteStore.Interface) => RemoteStore.Interface) =>
  RemoteStore.node.replace(
    RemoteStore.node.mapLayer((layer) =>
      Layer.effect(RemoteStore.Service, Effect.map(RemoteStore.Service, decorate)).pipe(Layer.provide(layer)),
    ),
  )

export const projectStoreReplacement = (decorate: (store: ProjectStore.Interface) => ProjectStore.Interface) =>
  ProjectStore.node.replace(
    ProjectStore.node.mapLayer((layer) =>
      Layer.effect(ProjectStore.Service, Effect.map(ProjectStore.Service, decorate)).pipe(Layer.provide(layer)),
    ),
  )

type SecureRandomService = Effect.Success<typeof SecureRandom.SecureRandom>

export const cryptoReplacement = (decorate: (crypto: SecureRandomService) => SecureRandomService) =>
  platform.replace(
    LayerNode.make({
      name: "test/Platform",
      layer: Layer.effect(SecureRandom.SecureRandom, Effect.map(SecureRandom.SecureRandom, decorate)).pipe(
        Layer.provideMerge(platformServices),
      ),
      deps: [],
    }),
  )

export const scriptedLeaves = (leaves: ReadonlyArray<string>) => {
  let drawn = 0

  return (crypto: SecureRandomService): SecureRandomService => ({
    ...crypto,
    randomBytes: (size) =>
      size === 2
        ? Effect.sync(() => {
            const leaf = leaves[drawn++ % leaves.length]!

            return Uint8Array.from([Number.parseInt(leaf.slice(0, 2), 16), Number.parseInt(leaf.slice(2), 16)])
          })
        : crypto.randomBytes(size),
  })
}

export const makeRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* tempDirectory("vibest-repo-")
  yield* fs.writeFileString(path.join(root, "README.md"), "hi\n")
  yield* fs.writeFileString(path.join(root, "CLAUDE.md"), "local rules\n")
  yield* (yield* FakeGit).repository(root, { files: { "README.md": "hi\n" } })

  return root
}).pipe(Effect.orDie)

export const sessionLayer = (replacements: LayerNode.Replacements = [], plugins = pluginsHost()) =>
  compile(
    LayerNode.group([
      ownTmpdir,
      platform,
      home,
      PlatformNode.sqlClient,
      Runtimes.hostEnvNode,
      Identity.node,
      DaemonHandlers.identityNode,
      DaemonHandlers.shutdownNode,
      fakeProcesses,
      Processes.node,
      fakeGit,
      runtimeNode,
      services,
      App.node,
      UpdateCheck.node,
      plugins,
      Agents.node,
      readyOnStart,
    ]),
    [
      PlatformNode.layout.replace(home),
      App.node.replace(Layer.succeed(App.Service, { version: "test" })),
      UpdateCheck.node.replace(Layer.succeed(UpdateCheck.Service, Effect.succeed(NOT_CHECKED))),
      Runtimes.node.replace(runtimes),
      Harness.node.replace(harnessLayer()),
      Harnesses.node.replace(harnessesLayer()),
      Subscriptions.node.replace(subscriptions),
      Mcp.hostNode.replace(Layer.succeed(Mcp.Host, McpRuntime.make)),
      Plugins.node.replace(plugins),
      RepositoryUrl.node.replace(defaultSsh),
      Machines.machineTransportNode.replace(defaultTransport),
      Load.hostSampleNode.replace(
        Layer.succeed(Load.HostSample, {
          read: Effect.succeed({
            cpu: { count: 4, utilization: 0.25 },
            memory: { total: 8_000_000_000, available: 4_000_000_000 },
          }),
        }),
      ),
      Runtimes.hostEnvNode.replace(noHostEnv),
      Identity.node.replace(Layer.sync(Identity.Service, () => ({ id: randomId(), name: "test-host" }))),
      DaemonHandlers.identityNode.replace(Layer.succeed(DaemonHandlers.Identity, {})),
      DaemonHandlers.shutdownNode.replace(Layer.effect(DaemonHandlers.Shutdown, Deferred.make<void>())),
      ...replacements,
    ],
  )

export const sshHosts = (hosts: Readonly<Record<string, string>> | undefined) =>
  Layer.succeed(RepositoryUrl.Service, { hostName: (alias: string) => Effect.succeed(hosts?.[alias] ?? alias) })

export const transportLayer = (transport: Machines.MachineTransport["Service"] | undefined) =>
  Layer.succeed(Machines.MachineTransport, transport ?? noTransport)

export interface TestOptions extends FakeRuntimeOptions {
  readonly hooked?: ReadonlyArray<string>
  readonly unusable?: ReadonlyArray<string>
  readonly models?: ReadonlyArray<string>
  readonly plugins?: ReadonlyArray<
    VibestPlugin.Plugin.Plugin | { readonly plugin: VibestPlugin.Plugin.Plugin; readonly options?: Schema.JsonObject }
  >
  readonly pluginTimeout?: Duration.Input
  readonly activateLate?: boolean
  readonly sessionStore?: (store: SessionStore.Interface) => SessionStore.Interface
  readonly inboxStore?: (store: InboxStore.Interface) => InboxStore.Interface
  readonly remoteStore?: (store: RemoteStore.Interface) => RemoteStore.Interface
  readonly projectStore?: (store: ProjectStore.Interface) => ProjectStore.Interface
  readonly crypto?: (crypto: SecureRandomService) => SecureRandomService
  readonly missingBinary?: ReadonlyArray<string>
  readonly harnesses?: ReadonlyArray<HarnessDefinition>
  readonly sshHosts?: Readonly<Record<string, string>>
  readonly transport?: Machines.MachineTransport["Service"]
  readonly sessions?: (sessions: Session.Interface, sessionStore: SessionStore.Interface) => Session.Interface
  readonly identity?: DaemonIdentity
  readonly version?: string
}

export const unusedRuntime = (
  id: string,
  caller: VibestPlugin.Runtime.RuntimeCaller | undefined,
  overrides: Partial<VibestPlugin.Runtime.RuntimeDefinition> = {},
): VibestPlugin.Runtime.RuntimeDefinition => {
  const unused = () => Effect.die(new Error(`runtime ${id} is only a caller`))

  return {
    id,
    ...(caller !== undefined && { caller }),
    status: () => Effect.succeed({ status: "online" }),
    open: unused,
    send: unused,
    read: unused,
    process: unused,
    close: unused,
    events: Stream.empty,
    ...overrides,
  }
}

export const callerPlugin = (id: string, caller: VibestPlugin.Runtime.RuntimeCaller) =>
  VibestPlugin.Plugin.define({
    id: `runtime-${id}-caller`,
    effect: (context) =>
      context.runtime.transform((editor) => editor.add(unusedRuntime(id, caller))).pipe(Effect.asVoid),
  })

const harnessStandIn = (options: TestOptions) => ({
  ...(options.hooked !== undefined && { hooked: options.hooked }),
  ...(options.unusable !== undefined && { unusable: options.unusable }),
  ...(options.models !== undefined && { models: options.models }),
  ...(options.missingBinary !== undefined && { missingBinary: options.missingBinary }),
  ...(options.harnesses !== undefined && { harnesses: options.harnesses }),
})

export const sessionFrom = (options: TestOptions = {}) =>
  sessionLayer(
    [
      runtimeNode.replace(FakeRuntime.layer(options)),
      Harness.node.replace(harnessLayer(harnessStandIn(options))),
      Harnesses.node.replace(harnessesLayer(options.harnesses)),
      ...(options.version === undefined
        ? []
        : [App.node.replace(Layer.succeed(App.Service, { version: options.version }))]),
      ...(options.sessions === undefined ? [] : [sessionsDecorated(options.sessions)]),
      ...(options.sessionStore === undefined ? [] : [sessionStoreReplacement(options.sessionStore)]),
      ...(options.inboxStore === undefined ? [] : [inboxStoreReplacement(options.inboxStore)]),
      ...(options.remoteStore === undefined ? [] : [remoteStoreReplacement(options.remoteStore)]),
      ...(options.projectStore === undefined ? [] : [projectStoreReplacement(options.projectStore)]),
      ...(options.crypto === undefined ? [] : [cryptoReplacement(options.crypto)]),
      RepositoryUrl.node.replace(sshHosts(options.sshHosts)),
      Machines.machineTransportNode.replace(transportLayer(options.transport)),
      ...(options.identity === undefined
        ? []
        : [DaemonHandlers.identityNode.replace(Layer.succeed(DaemonHandlers.Identity, options.identity))]),
    ],
    pluginsHost(options.plugins ?? [], {
      ...(options.pluginTimeout !== undefined && { timeout: options.pluginTimeout }),
      ...(options.activateLate !== undefined && { activateLate: options.activateLate }),
    }),
  )

export type TestServices = Layer.Success<ReturnType<typeof sessionFrom>> | FakeRuntime

export { sessionFrom as testLayer }

export const restartSessions = Effect.gen(function* () {
  const held = [
    Agents.node.replace(Layer.succeed(Agents.Service, yield* Agents.Service)),
    Bus.node.replace(Layer.succeed(Bus.Service, yield* Bus.Service)),
    Database.node.replace(Layer.succeed(Database.Service, yield* Database.Service)),
    ProjectStore.node.replace(Layer.succeed(ProjectStore.Service, yield* ProjectStore.Service)),
    SessionStore.node.replace(Layer.succeed(SessionStore.Service, yield* SessionStore.Service)),
    InboxStore.node.replace(Layer.succeed(InboxStore.Service, yield* InboxStore.Service)),
    RemoteStore.node.replace(Layer.succeed(RemoteStore.Service, yield* RemoteStore.Service)),
    Drain.node.replace(Layer.succeed(Drain.Service, yield* Drain.Service)),
    Git.node.replace(Layer.succeed(Git.Service, yield* Git.Service)),
    Harness.node.replace(Layer.succeed(Harness.Service, yield* Harness.Service)),
    Harnesses.node.replace(Layer.succeed(Harnesses.Service, yield* Harnesses.Service)),
    Inbox.node.replace(Layer.succeed(Inbox.Service, yield* Inbox.Service)),
    Plugins.node.replace(Layer.succeed(Plugins.Service, yield* Plugins.Service)),
    Processes.node.replace(Layer.succeed(Processes.Service, yield* Processes.Service)),
    Runtimes.node.replace(Layer.succeed(Runtimes.Service, yield* Runtimes.Service)),
    Subscriptions.node.replace(Layer.succeed(Subscriptions.Service, yield* Subscriptions.Service)),
    PlatformNode.childProcessSpawner.replace(
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, yield* ChildProcessSpawner.ChildProcessSpawner),
    ),
    PlatformNode.secureRandom.replace(Layer.succeed(SecureRandom.SecureRandom, yield* SecureRandom.SecureRandom)),
    PlatformNode.fileSystem.replace(Layer.succeed(FileSystem.FileSystem, yield* FileSystem.FileSystem)),
    PlatformNode.layout.replace(Layer.succeed(Layout, yield* Layout)),
    App.node.replace(Layer.succeed(App.Service, yield* App.Service)),
    PlatformNode.path.replace(Layer.succeed(Path.Path, yield* Path.Path)),
  ]

  const fresh = yield* Layer.build(
    Layer.fresh(LayerNode.compile(LayerNode.group([Session.node]), { replacements: held })),
  )

  return Context.get(fresh, Session.Service)
})
