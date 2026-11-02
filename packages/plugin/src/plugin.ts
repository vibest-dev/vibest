import type { Effect, Scope } from "effect"
import type { Context } from "./index.ts"

export interface Plugin {
  readonly id: string
  /** Setup: register hooks. Runs once per load in the plugin's own scope; resources acquired here are released on unload. */
  readonly effect: (ctx: Context) => Effect.Effect<void, never, Scope.Scope>
}

/** Returns the plugin unchanged; it only gives the object its type. */
export const define = (plugin: Plugin) => plugin
