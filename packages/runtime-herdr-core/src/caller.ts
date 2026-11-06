import { Config, Effect, Option } from "effect"

import { terminalId } from "./terminal-runtime.ts"

export const CALLER_ENV = ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"] as const

const env = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Effect.map((value) => Option.getOrUndefined(Option.filter(value, (v) => v !== ""))),
    Effect.orElseSucceed(() => undefined),
  )

export const callerTerminal = Effect.gen(function* () {
  const address = yield* env("HC_TERMINAL_ID")
  const socket = yield* env("HC_TERMINAL_SOCKET")
  return address !== undefined && socket !== undefined ? terminalId(socket, address) : undefined
})
