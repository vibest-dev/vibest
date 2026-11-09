import type { Effect, Scope } from "effect"

import type { Context } from "./index.ts"

export interface Plugin {
  readonly id: string
  readonly effect: (context: Context) => Effect.Effect<void, never, Scope.Scope>
}

export const define = (plugin: Plugin) => plugin
