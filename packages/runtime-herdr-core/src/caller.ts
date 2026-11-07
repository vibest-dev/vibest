import { Effect } from "effect"

import { terminalId } from "./terminal-runtime.ts"

export const CALLER_ENV = ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"] as const
export const CALLER_PRIORITY = 0

export const terminalFrom = (env: Readonly<Record<string, string | undefined>>) => {
  const address = env.HC_TERMINAL_ID
  const socket = env.HC_TERMINAL_SOCKET
  return address !== undefined && address !== "" && socket !== undefined && socket !== ""
    ? terminalId(socket, address)
    : undefined
}

export const callerTerminal = Effect.sync(() => terminalFrom(process.env))
