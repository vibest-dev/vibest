import { Agents } from "@vibest/core/agents"
import { App } from "@vibest/core/app"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { Drain } from "@vibest/core/drain"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { PlatformNode } from "@vibest/core/effect/platform"
import { Git } from "@vibest/core/git"
import { Harness } from "@vibest/core/harness"
import { Harnesses } from "@vibest/core/harnesses"
import { Identity } from "@vibest/core/identity"
import { Inbox } from "@vibest/core/inbox"
import { type Candidate, makeHost, Plugins, pluginsNode } from "@vibest/core/plugin"
import type { HarnessDefinition, RuntimeDefinition } from "@vibest/core/plugin/domains"
import * as Hooks from "@vibest/core/plugin/hooks"
import { Processes } from "@vibest/core/processes"
import { RepositoryUrl } from "@vibest/core/repository-url"
import { Runtimes, make as makeRuntimes } from "@vibest/core/runtimes"
import { Session } from "@vibest/core/session"
import { Spawn } from "@vibest/core/session/spawn"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import * as VibestPlugin from "@vibest/plugin/effect"
import { NOT_CHECKED, type DaemonIdentity } from "@vibest/protocol/rpc"
import { randomId } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import {
  Clock,
  ConfigProvider,
  Context,
  Crypto,
  Deferred,
  type Duration,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/process"

import { agentPlugin } from "../../../builtins/src/agent.ts"
import { choicePlugin } from "../../../runtime-herdr/src/choice.ts"
import { DaemonHandlers } from "../../../server/src/handlers/daemon.ts"
import { Machines } from "../../../server/src/machine/machines.ts"
import { services } from "../../../server/src/services.ts"
import { UpdateCheck } from "../../../server/src/update-check.ts"
import { services as platformServices } from "../platform/bun.ts"
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
  deps: [runtimeNode, Bus.node, Runtimes.hostEnvNode],
})

const subscriptions = LayerNode.make({
  service: Subscriptions,
  layer: Subscriptions.testLayer,
  deps: [Harness.node, Harnesses.node],
})

export type PluginEntry =
  | VibestPlugin.Plugin.Plugin
  | { readonly plugin: VibestPlugin.Plugin.Plugin; readonly options?: Readonly<Record<string, unknown>> }

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
  const candidates: ReadonlyArray<Candidate> = [
    { source: "test:agent", revision: "-", options: {}, plugin: agentPlugin },
    { source: "test:runtime-choice", revision: "-", options: {}, plugin: choicePlugin() },
    ...added.map(candidateOf),
  ]
  return LayerNode.make({
    name: "test/Plugins",
    layer: Layer.effectContext(
      Effect.gen(function* () {
        const host = yield* makeHost(options.timeout === undefined ? {} : { timeout: options.timeout })
        if (options.activateLate) {
          const release = host.holdNow()
          yield* host.activate(candidates).pipe(Effect.andThen(release), Effect.forkScoped)
        } else yield* host.activate(candidates)
        return Context.make(Plugins, host.service).pipe(
          Context.add(PluginHost, {
            load: (added) => host.activate([...candidates, ...added.map(candidateOf)]),
          }),
        )
      }),
    ),
    deps: [
      Agents.node,
      Bus.node,
      Harnesses.node,
      Hooks.Service.node,
      Runtimes.node,
      Subscriptions.node,
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
      const db = yield* Db
      let pid = 50_000
      yield* Ref.set(fake.onStarted, (session) =>
        Clock.currentTimeMillis.pipe(Effect.flatMap((at) => db.session.patchLive(session, { ready: at, pid: ++pid }))),
      )
    }),
  ),
  deps: [runtimeNode, Db.node],
})

const noTransport: Machines.MachineTransport["Service"] = () =>
  Effect.fail(new Error("no machine transport in this test"))

const defaultSsh = Layer.succeed(RepositoryUrl.Service, { hostName: (alias) => Effect.succeed(alias) })

const defaultTransport = Layer.succeed(Machines.MachineTransport, noTransport)

const defaultSpawn = Spawn.configured({ maxSessions: undefined })

const sessionsDecorated = (decorate: (sessions: Session.Interface, db: Db["Service"]) => Session.Interface) =>
  Session.node.replace(
    LayerNode.make({
      service: Session.Service,
      layer: Layer.effect(
        Session.Service,
        Effect.gen(function* () {
          return decorate(yield* Session.make, yield* Db)
        }),
      ),
      deps: Session.deps,
    }),
  )

export const dbReplacement = (decorate: (db: Db["Service"]) => Db["Service"]) =>
  Db.node.replace(Db.node.mapLayer((layer) => Layer.effect(Db, Effect.map(Db, decorate)).pipe(Layer.provide(layer))))

export const cryptoReplacement = (decorate: (crypto: Crypto.Crypto) => Crypto.Crypto) =>
  platform.replace(
    LayerNode.make({
      name: "test/Platform",
      layer: Layer.effect(Crypto.Crypto, Effect.map(Crypto.Crypto, decorate)).pipe(
        Layer.provideMerge(platformServices),
      ),
      deps: [],
    }),
  )

export const scriptedLeaves = (leaves: ReadonlyArray<string>) => {
  let drawn = 0
  return (crypto: Crypto.Crypto): Crypto.Crypto => ({
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
      pluginsNode.replace(plugins),
      Spawn.node.replace(defaultSpawn),
      RepositoryUrl.node.replace(defaultSsh),
      Machines.machineTransportNode.replace(defaultTransport),
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
  readonly maxSessions?: number
  readonly plugins?: ReadonlyArray<
    | VibestPlugin.Plugin.Plugin
    | { readonly plugin: VibestPlugin.Plugin.Plugin; readonly options?: Readonly<Record<string, unknown>> }
  >
  readonly pluginTimeout?: Duration.Input
  readonly activateLate?: boolean
  readonly db?: (db: Db["Service"]) => Db["Service"]
  readonly crypto?: (crypto: Crypto.Crypto) => Crypto.Crypto
  readonly missingBinary?: ReadonlyArray<string>
  readonly harnesses?: ReadonlyArray<HarnessDefinition>
  readonly sshHosts?: Readonly<Record<string, string>>
  readonly transport?: Machines.MachineTransport["Service"]
  readonly sessions?: (sessions: Session.Interface, db: Db["Service"]) => Session.Interface
  readonly identity?: DaemonIdentity
  readonly version?: string
}

const unusedRuntime = (
  id: string,
  caller: VibestPlugin.Runtime.RuntimeCaller,
): VibestPlugin.Runtime.RuntimeDefinition => {
  const unused = () => Effect.die(new Error(`runtime ${id} is only a caller`))
  return {
    id,
    caller,
    status: () => Effect.succeed({ status: "online" }),
    open: unused,
    send: unused,
    read: unused,
    process: unused,
    close: unused,
    events: Stream.empty,
  }
}

export const callerPlugin = (id: string, caller: VibestPlugin.Runtime.RuntimeCaller) =>
  VibestPlugin.Plugin.define({
    id: `runtime-${id}-caller`,
    effect: (context) =>
      context.runtime.transform((editor) => editor.add(unusedRuntime(id, caller))).pipe(Effect.asVoid),
  })

const harnessStandIn = (options: TestOptions) => ({
  ...(options.hooked === undefined ? {} : { hooked: options.hooked }),
  ...(options.unusable === undefined ? {} : { unusable: options.unusable }),
  ...(options.models === undefined ? {} : { models: options.models }),
  ...(options.missingBinary === undefined ? {} : { missingBinary: options.missingBinary }),
  ...(options.harnesses === undefined ? {} : { harnesses: options.harnesses }),
})

export const sessionFrom = (options: TestOptions = {}) =>
  sessionLayer(
    [
      runtimeNode.replace(FakeRuntime.layer(options)),
      Harness.node.replace(harnessLayer(harnessStandIn(options))),
      Harnesses.node.replace(harnessesLayer(options.harnesses)),
      Spawn.node.replace(Spawn.configured({ maxSessions: options.maxSessions })),
      ...(options.version === undefined
        ? []
        : [App.node.replace(Layer.succeed(App.Service, { version: options.version }))]),
      ...(options.sessions === undefined ? [] : [sessionsDecorated(options.sessions)]),
      ...(options.db === undefined ? [] : [dbReplacement(options.db)]),
      ...(options.crypto === undefined ? [] : [cryptoReplacement(options.crypto)]),
      RepositoryUrl.node.replace(sshHosts(options.sshHosts)),
      Machines.machineTransportNode.replace(transportLayer(options.transport)),
      ...(options.identity === undefined
        ? []
        : [DaemonHandlers.identityNode.replace(Layer.succeed(DaemonHandlers.Identity, options.identity))]),
    ],
    pluginsHost(options.plugins ?? [], {
      ...(options.pluginTimeout === undefined ? {} : { timeout: options.pluginTimeout }),
      ...(options.activateLate === undefined ? {} : { activateLate: options.activateLate }),
    }),
  )

export type TestServices = Layer.Success<ReturnType<typeof sessionFrom>> | FakeRuntime

export { sessionFrom as testLayer }

export const restartSessions = Effect.gen(function* () {
  const held = [
    Agents.node.replace(Layer.succeed(Agents.Service, yield* Agents.Service)),
    Bus.node.replace(Layer.succeed(Bus, yield* Bus)),
    Db.node.replace(Layer.succeed(Db, yield* Db)),
    Drain.node.replace(Layer.succeed(Drain.Service, yield* Drain.Service)),
    Git.node.replace(Layer.succeed(Git.Service, yield* Git.Service)),
    Harness.node.replace(Layer.succeed(Harness.Service, yield* Harness.Service)),
    Harnesses.node.replace(Layer.succeed(Harnesses.Service, yield* Harnesses.Service)),
    Inbox.node.replace(Layer.succeed(Inbox.Service, yield* Inbox.Service)),
    pluginsNode.replace(Layer.succeed(Plugins, yield* Plugins)),
    Processes.node.replace(Layer.succeed(Processes.Service, yield* Processes.Service)),
    Runtimes.node.replace(Layer.succeed(Runtimes.Service, yield* Runtimes.Service)),
    Subscriptions.node.replace(Layer.succeed(Subscriptions, yield* Subscriptions)),
    PlatformNode.childProcessSpawner.replace(
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, yield* ChildProcessSpawner.ChildProcessSpawner),
    ),
    PlatformNode.crypto.replace(Layer.succeed(Crypto.Crypto, yield* Crypto.Crypto)),
    PlatformNode.fileSystem.replace(Layer.succeed(FileSystem.FileSystem, yield* FileSystem.FileSystem)),
    PlatformNode.layout.replace(Layer.succeed(Layout, yield* Layout)),
    App.node.replace(Layer.succeed(App.Service, yield* App.Service)),
    PlatformNode.path.replace(Layer.succeed(Path.Path, yield* Path.Path)),
    Spawn.node.replace(defaultSpawn),
  ]
  const fresh = yield* Layer.build(
    Layer.fresh(LayerNode.compile(LayerNode.group([Session.node]), { replacements: held })),
  )
  return Context.get(fresh, Session.Service)
})
