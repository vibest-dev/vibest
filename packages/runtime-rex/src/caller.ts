import type * as VibestPlugin from "@vibest/plugin/effect"
import { Effect } from "effect"

import type { RexTerminal } from "./terminal-runtime.ts"

export const CALLER_ENV = ["REX_SESSION", "REX_BLOCK"] as const

export const terminalFrom = (env: Readonly<Record<string, string | undefined>>): RexTerminal | undefined => {
  const session = env.REX_SESSION
  const block = env.REX_BLOCK

  return session !== undefined && session !== "" && block !== undefined && block !== "" ? { session, block } : undefined
}

export const caller: VibestPlugin.Runtime.RuntimeCaller<RexTerminal> = {
  env: CALLER_ENV,
  terminal: (env) => Effect.succeed(terminalFrom(env)),
  target: (env, named) => named || env.REX_SESSION || undefined,
}
