import type { Plugin as EffectPlugin } from "./effect/plugin.ts"
import { fromPromise } from "./promise/adapter.ts"
import type { Plugin as PromisePlugin } from "./promise/plugin.ts"

export type Plugin = EffectPlugin | PromisePlugin

export const effectOf = (plugin: Plugin) => ("effect" in plugin ? plugin.effect : fromPromise(plugin))
