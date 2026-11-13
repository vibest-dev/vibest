import { HarnessUnavailable, addPluginHint } from "@vibest/schema/session"
import { Effect, Option } from "effect"

import { caller, json } from "./caller.ts"
import { withVibest } from "./client.ts"

export const catalog = (provider?: string, machine?: string) =>
  Effect.flatMap(caller, (c) =>
    withVibest(c.claim, (client) => client["Harnesses.List"]({ provider, machine }), { start: !c.agent }),
  )

export const modelsOf = (harness: string | undefined, provider: Option.Option<string>) =>
  Effect.gen(function* () {
    const all = yield* catalog(Option.getOrUndefined(provider))
    const choices = harness === undefined ? all : all.filter((c) => c.harness === harness)
    if (harness !== undefined && choices.length === 0)
      return yield* new HarnessUnavailable({
        harness,
        message: `no plugin provides harness ${harness}; loaded: ${all.map((c) => c.harness).join(", ") || "none"}; ${addPluginHint}`,
      })
    const models = choices.flatMap((c) =>
      c.problem === null ? c.models.map((m) => ({ harness: c.harness, ...m })) : [],
    )
    const errors = choices.flatMap((c) =>
      c.problem !== null
        ? [`${c.harness}: ${c.problem}`]
        : c.models.length === 0
          ? [`${c.harness}: ${c.binary} lists no models for provider "${Option.getOrNull(provider)}"`]
          : [],
    )
    yield* json({ models, errors })
  })
