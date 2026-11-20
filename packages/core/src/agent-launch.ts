import type { AgentDefinition } from "./plugin/domains.ts"

export interface LaunchChoice {
  readonly harness?: string | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

const LAUNCH_FIELDS = ["harness", "provider", "model"] as const

export const definitionLaunch = (definition: AgentDefinition, named: LaunchChoice) => {
  if (named.harness !== undefined || definition.harness === undefined) return undefined

  const choice: LaunchChoice = {
    harness: definition.harness,
    provider: named.provider ?? definition.provider,
    model: named.model ?? definition.model,
  }

  const decider = `agent:${definition.id}`

  const decidedBy = Object.fromEntries(
    LAUNCH_FIELDS.flatMap((field) =>
      named[field] === undefined && definition[field] !== undefined ? [[field, decider]] : [],
    ),
  )

  return { choice, decidedBy }
}
