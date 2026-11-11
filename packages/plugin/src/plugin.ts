import type { Effect, Scope } from "effect"

import type { Context } from "./index.ts"
import { fromPromise, type PromiseContext } from "./promise.ts"

export type Cleanup = () => Promise<void> | void

export interface EffectPlugin {
  readonly id: string
  readonly effect: (context: Context) => Effect.Effect<void, never, Scope.Scope>
}

export interface PromisePlugin {
  readonly id: string
  readonly setup: (context: PromiseContext) => Promise<Cleanup | void> | Cleanup | void
}

export type Plugin = EffectPlugin | PromisePlugin

export const define = <P extends Plugin>(plugin: P) => plugin

export const effectOf = (plugin: Plugin) => ("effect" in plugin ? plugin.effect : fromPromise(plugin))
