import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as VibestPlugin from "@vibest/plugin"
import { Effect, Layer } from "effect"
import { defaultSocketPath, Hc, SocketConnector } from "effect-hc-sdk"

import { make } from "./terminal-runtime.ts"

const platform = Layer.mergeAll(
  Layer.succeed(SocketConnector, (endpoint: string) => NodeSocket.makeNet({ path: endpoint })),
  NodePath.layer,
)

export const plugin: VibestPlugin.Plugin.Plugin = VibestPlugin.Plugin.define({
  id: "runtime-hc",
  effect: (context) =>
    Effect.gen(function* () {
      const hc = yield* defaultSocketPath().pipe(Effect.flatMap(Hc.make), Effect.provide(platform), Effect.orDie)
      yield* context.runtime.register(yield* make({ hc, scope: yield* Effect.scope }))
    }),
})
