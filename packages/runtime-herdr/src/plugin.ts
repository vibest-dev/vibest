import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as VibestPlugin from "@vibest/plugin/effect"
import { Context, Effect, FileSystem, Layer } from "effect"
import { SocketConnector } from "effect-herdr-sdk"
import { ChildProcessSpawner } from "effect/process"

import { CALLER_ENV, readyFrom, targetFrom, terminalFrom } from "./caller.ts"
import * as Machines from "./machines.ts"
import * as Mirror from "./mirror.ts"
import { HerdrPool } from "./pool.ts"
import { KIND, fromPool } from "./terminal-runtime.ts"

const platform = Layer.mergeAll(
  Layer.succeed(SocketConnector, (endpoint: string) => NodeSocket.makeNet({ path: endpoint })),
  NodeFileSystem.layer,
  NodePath.layer,
)

const callerServices = Layer.provideMerge(NodeChildProcessSpawner.layer, platform)

export const layer = HerdrPool.layer.pipe(Layer.provideMerge(callerServices))

const caller: VibestPlugin.Runtime.RuntimeCaller = {
  env: CALLER_ENV,
  terminal: (env) => terminalFrom(env).pipe(Effect.provide(callerServices)),
  ready: (env) => readyFrom(env).pipe(Effect.provide(platform)),
  missing: "this pane's herdr session could not be named; run vibest outside herdr",
  target: targetFrom,
}

export const plugin: VibestPlugin.Plugin.Plugin = VibestPlugin.Plugin.define({
  id: "runtime-herdr",
  effect: (context) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const built = yield* Layer.build(layer)
      const spawner = Context.get(built, ChildProcessSpawner.ChildProcessSpawner)
      const cli = Machines.cliOf(spawner)
      const pool = Context.get(built, HerdrPool)
      const runtime = yield* fromPool({
        pool,
        spawner,
        fs: Context.get(built, FileSystem.FileSystem),
        scope,
      })
      yield* context.runtime.transform((editor) =>
        editor.add({
          ...runtime,
          id: KIND,
          caller,
          link: () => Machines.link(pool),
          locate: (peer, sessions) => Machines.locate(cli, peer, sessions),
        }),
      )
      yield* Mirror.mirror(context.machine, cli)
    }),
})
