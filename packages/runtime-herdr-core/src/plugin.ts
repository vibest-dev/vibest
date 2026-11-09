import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as VibestPlugin from "@vibest/plugin"
import { Effect, Layer } from "effect"
import { defaultSocketPath, Hc, SocketConnector } from "effect-herdr-core-sdk"

import { CALLER_ENV, terminalFrom } from "./caller.ts"
import { KIND, make } from "./terminal-runtime.ts"

const platform = Layer.mergeAll(
  Layer.succeed(SocketConnector, (endpoint: string) => NodeSocket.makeNet({ path: endpoint })),
  NodePath.layer,
)

export const plugin: VibestPlugin.Plugin.Plugin = VibestPlugin.Plugin.define({
  id: "runtime-herdr-core",
  caller: {
    kind: KIND,
    env: CALLER_ENV,
    terminal: (env) => Effect.succeed(terminalFrom(env)),
  },
  effect: (context) =>
    Effect.gen(function* () {
      const socket = yield* defaultSocketPath().pipe(Effect.provide(platform), Effect.orDie)
      const connect = (socketPath: string) => Effect.runSync(Hc.make(socketPath).pipe(Effect.provide(platform)))
      yield* context.runtime.register(yield* make({ connect, socket, scope: yield* Effect.scope }))
    }),
})
