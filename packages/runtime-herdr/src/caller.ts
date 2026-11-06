import type { Runtime } from "@vibest/plugin"
import { Config, Effect, Option, Schema } from "effect"
import { Herdr, SocketConnector } from "effect-herdr-sdk"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { encodeTarget, failure, terminalOf } from "./terminal-runtime.ts"

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

export const callerCapability = Effect.gen(function* () {
  const connector = yield* Effect.context<SocketConnector>()
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return {
    env: CALLER_ENV,
    detect: (env) =>
      Effect.gen(function* () {
        const pane = env.HERDR_PANE_ID
        const socket = env.HERDR_SOCKET_PATH
        if (!pane && !socket) return undefined
        if (!pane || !socket) return yield* Effect.fail(failure({ message: "incomplete caller environment" }))
        const list = yield* spawner
          .string(ChildProcess.make("herdr", ["session", "list", "--json"]))
          .pipe(Effect.flatMap(SessionList), Effect.mapError(failure))
        const session = list.sessions.find((s) => s.socket_path === socket)
        if (!session) return yield* Effect.fail(failure({ message: "caller session is unavailable" }))
        const terminal = terminalOf(session.name, pane)
        if (!session.running) return { terminal, live: false }
        const client = yield* Herdr.make(socket).pipe(Effect.provideContext(connector))
        return yield* Herdr.verifyProtocol(client).pipe(
          Effect.andThen(client.call("pane.process_info", { pane_id: pane })),
          Effect.flatMap((r) =>
            r.type === "pane_process_info"
              ? Effect.succeed({
                  terminal,
                  live: r.process_info.shell_pid != null,
                  ...(r.process_info.shell_pid == null ? {} : { localRootPid: r.process_info.shell_pid }),
                })
              : Effect.fail(failure({ message: "invalid caller process reply" })),
          ),
          Effect.mapError(failure),
          Effect.catchTag("RuntimeError", (error) =>
            error.code === "not_found" ? Effect.succeed({ terminal, live: false }) : Effect.fail(error),
          ),
        )
      }),
  } satisfies NonNullable<Runtime.Runtime["caller"]>
})
