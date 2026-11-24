import os from "node:os"
import path from "node:path"

import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as VibestPlugin from "@vibest/plugin/effect"
import { Config, Effect, Option } from "effect"

import { caller } from "./caller.ts"
import { connect } from "./client.ts"
import { make } from "./terminal-runtime.ts"

const set = (name: string) => Config.option(Config.String(name)).pipe(Config.map(Option.filter((v) => v !== "")))

export const socketFrom = (env: {
  readonly socket: string | undefined
  readonly server: string | undefined
  readonly runtimeDir: string | undefined
  readonly platform: string
  readonly home: string
  readonly uid: number
}) => {
  if (env.socket !== undefined) return env.socket

  if (env.server?.startsWith("unix://")) return decodeURIComponent(env.server.slice("unix://".length))

  if (env.platform === "darwin") return path.join(env.home, "Library", "Application Support", "rex", "server.sock")

  return path.join(env.runtimeDir ?? `/run/user/${env.uid}`, "rex", "server.sock")
}

const socketPath = Effect.gen(function* () {
  return socketFrom({
    socket: Option.getOrUndefined(yield* set("REX_SOCKET")),
    server: Option.getOrUndefined(yield* set("REX_SERVER")),
    runtimeDir: Option.getOrUndefined(yield* set("XDG_RUNTIME_DIR")),
    platform: os.platform(),
    home: os.homedir(),
    uid: os.userInfo().uid,
  })
})

export const plugin: VibestPlugin.Plugin.Plugin = VibestPlugin.Plugin.define({
  id: "vibest.runtime-rex",
  effect: (context) =>
    Effect.gen(function* () {
      const socket = yield* socketPath.pipe(Effect.orDie)
      const shell = Option.getOrElse(yield* set("SHELL").pipe(Effect.orDie), () => "/bin/sh")

      const definition = yield* make({
        connect: connect((at) => NodeSocket.makeNet({ path: at }), socket),
        socket,
        scope: yield* Effect.scope,
        shell,
        caller,
      })

      yield* context.runtime.transform((editor) => editor.add(definition))
    }),
})
