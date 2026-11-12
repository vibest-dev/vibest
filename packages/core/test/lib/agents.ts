import { Agents, makeAgents } from "@vibest/core/agents"
import { Effect, Layer } from "effect"

import { coordinator, general } from "../../../builtins/src/agent.ts"

export const agentsLayer = Layer.effect(
  Agents,
  Effect.tap(makeAgents, (agents) =>
    agents.transform((editor) => {
      editor.add(coordinator)
      editor.add(general)
    }),
  ),
)
