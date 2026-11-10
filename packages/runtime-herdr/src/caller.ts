import { Effect, Schema } from "effect"
import { Herdr } from "effect-herdr-sdk"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { encodeTarget } from "./terminal-runtime.ts"

export const targetFrom = (env: Readonly<Record<string, string | undefined>>, named?: string): string | undefined => {
  if (named !== undefined) return encodeTarget({ session: named })
  const socketPath = env.HERDR_SOCKET_PATH
  if (socketPath === undefined || socketPath === "") return undefined
  return encodeTarget({ socketPath })
}

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

export const terminalFrom = (env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const paneId = env.HERDR_PANE_ID
    const socketPath = env.HERDR_SOCKET_PATH
    if (paneId === undefined || paneId === "" || socketPath === undefined || socketPath === "") return undefined
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const out = yield* spawner.string(ChildProcess.make("herdr", ["session", "list", "--json"]))
    const list = yield* SessionList(out)
    const session = list.sessions.find((s) => s.socket_path === socketPath)
    return session === undefined ? undefined : `${session.name}/${paneId}`
  })

export const readyFrom = (env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const socket = env.HERDR_SOCKET_PATH
    const pane = env.HERDR_PANE_ID
    if (socket === undefined || socket === "" || pane === undefined || pane === "") return false
    const client = yield* Herdr.make(socket)
    yield* Herdr.verifyProtocol(client)
    return true
  })
