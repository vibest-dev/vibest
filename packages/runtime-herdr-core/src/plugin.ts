import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as VibestPlugin from "@vibest/plugin/effect"
import { Config, Effect, Layer, Option, Stream } from "effect"
import { DEFAULT_SESSION, defaultSocketPath, Hc, SocketConnector } from "effect-herdr-core-sdk"

import { CALLER_ENV, terminalFrom } from "./caller.ts"
import * as Machines from "./machines.ts"
import { KIND, make } from "./terminal-runtime.ts"

const platform = Layer.mergeAll(
  Layer.succeed(SocketConnector, (endpoint: string) => NodeSocket.makeNet({ path: endpoint })),
  NodePath.layer,
)

const caller: VibestPlugin.Runtime.RuntimeCaller = {
  env: CALLER_ENV,
  terminal: (env) => Effect.succeed(terminalFrom(env)),
}

const set = (name: string) => Config.option(Config.String(name)).pipe(Config.map(Option.filter((v) => v !== "")))

const hcSession = Effect.gen(function* () {
  if (Option.isSome(yield* set("HC_SOCKET"))) return ""
  return Option.getOrElse(yield* set("HC_SESSION"), () => DEFAULT_SESSION)
})

export const plugin: VibestPlugin.Plugin.Plugin = VibestPlugin.Plugin.define({
  id: "runtime-herdr-core",
  effect: (context) =>
    Effect.gen(function* () {
      const socket = yield* defaultSocketPath().pipe(Effect.provide(platform), Effect.orDie)
      const session = yield* hcSession.pipe(Effect.orDie)
      const connect = (socketPath: string) => Hc.make(socketPath).pipe(Effect.provide(platform))
      const home = yield* connect(socket)
      const runtime = yield* make({ connect, socket, scope: yield* Effect.scope })
      const definition: VibestPlugin.Runtime.RuntimeDefinition = {
        ...runtime,
        id: KIND,
        name: "herdr-core",
        caller,
        link: () =>
          home.hello.pipe(
            Effect.map((hello) => ({ core: hello.core.id, session })),
            Effect.orElseSucceed(() => undefined),
          ),
        locate: (peer, sessions) => Machines.locate(home, socket, peer, sessions),
      }
      yield* context.runtime.transform((editor) => editor.add(definition))
      yield* Machines.mirror(
        context.machine,
        home,
        runtime.events.pipe(Stream.filter((event) => event.type === "reset")),
      )
    }),
})
