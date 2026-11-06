import type { Runtime } from "@vibest/plugin"
import { Effect } from "effect"
import type { HcShape } from "effect-herdr-core-sdk"

import { failure, terminalId } from "./terminal-runtime.ts"

export const CALLER_ENV = ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"] as const

export const callerCapability = (connect: (socket: string) => HcShape): NonNullable<Runtime.Runtime["caller"]> => ({
  env: CALLER_ENV,
  detect: (env) =>
    Effect.gen(function* () {
      const address = env.HC_TERMINAL_ID
      const socket = env.HC_TERMINAL_SOCKET
      if (!address && !socket) return undefined
      if (!address || !socket) return yield* Effect.fail(failure({ message: "incomplete caller environment" }))
      const terminal = { machine: "local", id: terminalId(socket, address) }
      if (!/^t[0-9]+$/.test(address)) return { terminal, live: true }
      return yield* connect(socket)
        .call("terminal.get", { terminal: address })
        .pipe(
          Effect.map((t) => ({
            terminal,
            live: t.state === "live",
            ...(t.pid === null || t.pid === undefined ? {} : { localRootPid: t.pid }),
          })),
          Effect.mapError(failure),
          Effect.catchTag("RuntimeError", (error) =>
            error.code === "not_found" ? Effect.succeed({ terminal, live: false }) : Effect.fail(error),
          ),
        )
    }),
})
