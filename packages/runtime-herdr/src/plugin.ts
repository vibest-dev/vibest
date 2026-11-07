import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as VibestPlugin from "@vibest/plugin"
import { Context, Effect, FileSystem, Layer } from "effect"
import { SocketConnector } from "effect-herdr-sdk"
import { ChildProcessSpawner } from "effect/process"

import { CALLER_ENV, readyFrom, terminalFrom } from "./caller.ts"
import { HerdrPool } from "./pool.ts"
import { KIND, fromPool } from "./terminal-runtime.ts"

const platform = Layer.mergeAll(
  Layer.succeed(SocketConnector, (endpoint: string) => NodeSocket.makeNet({ path: endpoint })),
  NodeFileSystem.layer,
  NodePath.layer,
)

const callerServices = Layer.provideMerge(NodeChildProcessSpawner.layer, platform)

export const layer = HerdrPool.layer.pipe(Layer.provideMerge(callerServices))

export const plugin: VibestPlugin.Plugin.Plugin = VibestPlugin.Plugin.define({
  id: "runtime-herdr",
  caller: {
    kind: KIND,
    env: CALLER_ENV,
    terminal: (env) => terminalFrom(env).pipe(Effect.provide(callerServices)),
    ready: (env) => readyFrom(env).pipe(Effect.provide(platform)),
    missing: "this pane's herdr session could not be named; run vibest outside herdr",
  },
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
