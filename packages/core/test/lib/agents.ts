import { Agents } from "@vibest/core/agents"
import { Effect, Layer } from "effect"

import { coordinator, general } from "../../../builtins/src/agent.ts"

export const agentsLayer = Layer.effect(
  Agents.Service,
  Effect.tap(Agents.make, (agents) =>
    agents.transform((editor) => {
      editor.add(coordinator)
      editor.add(general)
    }),
  ),
)
