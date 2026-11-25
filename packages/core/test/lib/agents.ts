import { Agents } from "@vibest/core/agents"
import { Effect, Layer } from "effect"

import { coordinator, general } from "../../../plugin-builtins/src/agent.ts"

export const agentsLayer = Layer.effect(
  Agents.Service,
  Effect.tap(Agents.make, (agents) =>
    agents.transformFor("test")((editor) => {
      editor.add(coordinator)
      editor.add(general)
    }),
  ),
)
