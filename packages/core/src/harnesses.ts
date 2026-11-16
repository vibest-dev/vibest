import { addPluginHint, HarnessUnavailable } from "@vibest/schema/session"
import { Context, Effect, Layer } from "effect"

import { LayerNode } from "./effect/layer-node.ts"
import type { HarnessDefinition, HarnessesShape } from "./plugin/domains.ts"
import * as Registry from "./plugin/registry.ts"

export * as Harnesses from "./harnesses.ts"

export const unprovided = (id: string, loaded: ReadonlyArray<HarnessDefinition>) =>
  new HarnessUnavailable({
    harness: id,
    message: `no plugin provides harness ${id}; loaded: ${loaded.map((definition) => definition.id).join(", ") || "none"}; ${addPluginHint}`,
  })

export const make: Effect.Effect<HarnessesShape> = Effect.sync(() => {
  const registry = Registry.definitions<HarnessDefinition>("harness")
  const find = (id: string | null | undefined) =>
    id ? registry.get().find((definition) => definition.id === id) : undefined
  return {
    get all() {
      return registry.get()
    },
    get: Effect.fn("Harnesses.get")((id) =>
      Effect.suspend(() => {
        const found = find(id)
        return found === undefined ? Effect.fail(unprovided(id, registry.get())) : Effect.succeed(found)
      }),
    ),
    find,
    transform: registry.transform,
  }
})

export type Interface = HarnessesShape

export class Service extends Context.Service<Service, Interface>()("vibest/Harnesses") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({ service: Service, layer, deps: [] })
