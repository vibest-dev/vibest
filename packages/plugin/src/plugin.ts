import type { Effect, Scope } from "effect"

import type { Context } from "./index.ts"

export interface Caller {
  readonly kind: string
  readonly env: ReadonlyArray<string>
  readonly overOtherCallers?: boolean
  readonly terminal: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<string | undefined, unknown, never>
  readonly ready?: (env: Readonly<Record<string, string | undefined>>) => Effect.Effect<boolean, unknown, never>
  readonly missing?: string
}

export interface Plugin {
  readonly id: string
  readonly caller?: Caller
  readonly effect: (ctx: Context) => Effect.Effect<void, never, Scope.Scope>
}

export const define = (plugin: Plugin) => plugin
