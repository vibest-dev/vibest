import type { Layer } from "effect"

import type { Tag, TagConfig, Tags } from "./layer-node.ts"

export const implementationOf = <A, E>(definition: { readonly implementation: Layer.Layer<never, unknown, unknown> }) =>
  definition.implementation as Layer.Layer<A, E, unknown>

export const tagValuesOf = <Config extends TagConfig>(values: { readonly [name: string]: Tag }) =>
  values as Tags<Config>["values"]

export const typedRoot = <A, E>(layer: Layer.Layer<never, unknown, unknown>) => layer as Layer.Layer<A, E>
