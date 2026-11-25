import { Agents } from "@vibest/core/agents"
import { coordinator, general } from "@vibest/plugin-builtins/agent"
import { Effect, Layer } from "effect"

export const agentsLayer = Layer.effect(
  Agents.Service,
  Effect.tap(Agents.make, (agents) =>
    agents.transformFor("test")((editor) => {
      editor.add(coordinator)
      editor.add(general)
    }),
  ),
)
