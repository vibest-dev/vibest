// The builtin `runtime-herdr` plugin (runtime-port.md §2, plan phase 9): registers the herdr Runtime in the plugin
// context, beside `agent.hook`. Its connections (the HerdrPool) live in the plugin's own scope and close with it.
// Self-contained: the plugin builds the services it needs (node:net socket dialing, node:fs, node:child_process), so
// it loads in any host that runs the plugin API.
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as VibestPlugin from "@vibest/plugin"
import { Context, Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SocketConnector } from "effect-herdr-sdk"
import { HerdrPool } from "./pool.ts"
import { fromPool } from "./terminal-runtime.ts"

/** The platform the pool needs, built here rather than asked of the host: a plugin carries its own. */
const platform = Layer.mergeAll(
  Layer.succeed(SocketConnector, (endpoint: string) => NodeSocket.makeNet({ path: endpoint })),
  NodeFileSystem.layer,
  NodePath.layer,
)

/** One pool of herdr sessions with its platform. */
export const layer = HerdrPool.layer.pipe(Layer.provideMerge(Layer.provideMerge(NodeChildProcessSpawner.layer, platform)))

/**
 * The herdr runtime plugin: one pool for the plugin's lifetime, one Runtime registered under `kind: "herdr"`.
 * A second registration of the same kind is a defect, which fails the plugin's setup.
 */
export const plugin: VibestPlugin.Plugin.Plugin = VibestPlugin.Plugin.define({
  id: "runtime-herdr",
  effect: (context) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const built = yield* Layer.build(layer)
      yield* context.runtime.register(
        yield* fromPool({
          pool: Context.get(built, HerdrPool),
          spawner: Context.get(built, ChildProcessSpawner.ChildProcessSpawner),
          fs: Context.get(built, FileSystem.FileSystem),
          scope,
        }),
      )
    }),
})
