import { Config, Effect, Option, Schema } from "effect"
import { Herdr } from "effect-herdr-sdk"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { encodeTarget } from "./terminal-runtime.ts"

export const callerLocation = (named?: string) =>
  Effect.gen(function* () {
    if (named !== undefined) return { session: named }
    const socketPath = Option.getOrUndefined(yield* Config.option(Config.String("HERDR_SOCKET_PATH")))
    return socketPath !== undefined ? { socketPath } : { session: "vibest" }
  })

export const callerMachine = (named?: string) =>
  callerLocation(named).pipe(Effect.map((location) => ({ id: "local", target: encodeTarget(location) })))

export const CALLER_ENV = ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"] as const

const SessionList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      sessions: Schema.Array(
        Schema.Struct({ name: Schema.String, socket_path: Schema.String, running: Schema.Boolean }),
      ),
    }),
  ),
)

export const callerTerminal = Effect.gen(function* () {
  const paneId = Option.getOrUndefined(yield* Config.option(Config.String("HERDR_PANE_ID")))
  const socketPath = Option.getOrUndefined(yield* Config.option(Config.String("HERDR_SOCKET_PATH")))
  if (paneId === undefined || paneId === "" || socketPath === undefined || socketPath === "") return undefined
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const out = yield* spawner.string(ChildProcess.make("herdr", ["session", "list", "--json"]))
  const list = yield* SessionList(out)
  const session = list.sessions.find((s) => s.socket_path === socketPath)
  return session === undefined ? undefined : `${session.name}/${paneId}`
})

export const ambientHerdr = Effect.gen(function* () {
  const socket = Option.getOrUndefined(yield* Config.option(Config.String("HERDR_SOCKET_PATH")))
  const pane = Option.getOrUndefined(yield* Config.option(Config.String("HERDR_PANE_ID")))
  if (socket === undefined || pane === undefined) return undefined
  const client = yield* Herdr.make(socket)
  yield* Herdr.verifyProtocol(client)
  return { h: client, paneId: pane } as const
})
