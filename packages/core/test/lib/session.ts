import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { Harness, Harnesses } from "@vibest/core/harness"
import type { HarnessDefinition, RuntimeDefinition } from "@vibest/core/host"
import { VibestdIdentity } from "@vibest/core/identity"
import { MachineTransport } from "@vibest/core/machines"
import { Layout } from "@vibest/core/paths"
import { type Candidate, makeHost, Plugins } from "@vibest/core/plugins"
import { Processes } from "@vibest/core/processes"
import { SshHosts } from "@vibest/core/repository-url"
import { HostEnv, make as makeRuntimes, Runtimes } from "@vibest/core/runtimes"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import * as VibestPlugin from "@vibest/plugin"
import type { DaemonIdentity } from "@vibest/protocol/rpc"
import { randomId } from "@vibest/schema/id"
import { Clock, ConfigProvider, Context, Deferred, type Duration, Effect, FileSystem, Layer, Path, Ref } from "effect"

import { choicePlugin } from "../../../runtime-herdr/src/choice.ts"
import * as App from "../../../server/src/app.ts"
import * as Server from "../../../server/src/server.ts"
import { tempDirectory } from "./directory.ts"
import { FakeGit } from "./fake-git.ts"
import { FakeRuntime, KIND, type FakeRuntimeOptions } from "./fake-runtime.ts"
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
  service: Runtimes,
  layer: Layer.effect(
    Runtimes,
    Effect.flatMap(FakeRuntime, (fake) => runtimesFrom([fake.runtime])),
  ),
  deps: [runtimeNode, Bus.node, HostEnv.node],
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
  const plugin = "effect" in entry ? entry : entry.plugin
  const pluginOptions = "effect" in entry ? {} : (entry.options ?? {})
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
    { source: "test:runtime-choice", revision: "-", options: {}, plugin: choicePlugin() },
    ...added.map(candidateOf),
  ]
  return LayerNode.make({
    name: "test/Plugins",
    layer: Layer.effectContext(
      Effect.gen(function* () {
        const host = yield* makeHost(options.timeout === undefined ? {} : { timeout: options.timeout })
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
    deps: [Bus.node, Harnesses.node, Runtimes.node, Subscriptions.node, platform, home],
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
        Clock.currentTimeMillis.pipe(Effect.flatMap((at) => db.patchLive(session, { ready: at, pid: ++pid }))),
      )
    }),
  ),
  deps: [runtimeNode, Db.node],
})

const noTransport: MachineTransport["Service"] = () => Effect.fail(new Error("no machine transport in this test"))

const defaultSsh = Layer.succeed(SshHosts, { hostName: (alias) => Effect.succeed(alias) })

const defaultTransport = Layer.succeed(MachineTransport, noTransport)

const defaultSessions = Sessions.configured({ maxSessions: undefined })

export const sessionsNode = (
  maxSessions: number | undefined,
  decorate?: (sessions: Sessions["Service"], db: Db["Service"]) => Sessions["Service"],
) => {
  const configured = Sessions.configured({ maxSessions })
  if (decorate === undefined) return configured
  return LayerNode.make({
    service: Sessions,
    layer: Layer.effect(
      Sessions,
      Effect.gen(function* () {
        return decorate(yield* Sessions, yield* Db)
      }),
    ),
    deps: [configured, Db.node],
  })
}

export const dbReplacement = (decorate: (db: Db["Service"]) => Db["Service"]) =>
  Db.node.replace(Db.node.mapLayer((layer) => Layer.effect(Db, Effect.map(Db, decorate)).pipe(Layer.provide(layer))))

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
      HostEnv.node,
      VibestdIdentity.node,
      Server.Identity.node,
      Server.Shutdown.node,
      fakeProcesses,
      Processes.node,
      fakeGit,
      runtimeNode,
      App.services,
      plugins,
      readyOnStart,
    ]),
    [
      PlatformNode.layout.replace(home),
      Runtimes.node.replace(runtimes),
      Harness.node.replace(harnessLayer()),
      Harnesses.node.replace(harnessesLayer()),
      Subscriptions.node.replace(subscriptions),
      Plugins.node.replace(plugins),
      Sessions.node.replace(defaultSessions),
      SshHosts.node.replace(defaultSsh),
      MachineTransport.node.replace(defaultTransport),
      HostEnv.node.replace(noHostEnv),
      VibestdIdentity.node.replace(Layer.sync(VibestdIdentity, () => ({ id: randomId(), name: "test-host" }))),
      Server.Identity.node.replace(Layer.succeed(Server.Identity, {})),
      Server.Shutdown.node.replace(Layer.effect(Server.Shutdown, Deferred.make<void>())),
      ...replacements,
    ],
  )

export const sshHosts = (hosts: Readonly<Record<string, string>> | undefined) =>
  Layer.succeed(SshHosts, { hostName: (alias: string) => Effect.succeed(hosts?.[alias] ?? alias) })

export const transportLayer = (transport: MachineTransport["Service"] | undefined) =>
  Layer.succeed(MachineTransport, transport ?? noTransport)

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

export type TestServices = Layer.Success<ReturnType<typeof sessionFrom>> | FakeRuntime

export { sessionFrom as testLayer }
