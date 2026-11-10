import { harnessCatalog, Harnesses, unprovided } from "@vibest/core/harness"
import { Integration } from "@vibest/core/integration"
import { forProvider } from "@vibest/core/models"
import { Caller, InvalidCaller } from "@vibest/protocol/rpc"
import { Effect } from "effect"

export const integrationHandlers = Effect.gen(function* () {
  const harnesses = yield* Harnesses
  const integration = yield* Integration
  return {
    "Harnesses.List": ({ provider }: { readonly provider?: string | undefined }) =>
      Effect.map(harnessCatalog, (choices) =>
        provider === undefined ? choices : forProvider(choices, harnesses, provider),
      ),

    "Integration.Guard": ({
      harness,
      agent,
      input,
    }: {
      readonly harness: string
      readonly agent: string
      readonly input: string
    }) =>
      Effect.gen(function* () {
        const definition = harnesses.find(harness)
        if (definition === undefined) return yield* unprovided(harness, harnesses.all)
        const caller = yield* Caller
        const reason = yield* integration
          .guard(agent, input, caller._tag === "Cli" ? undefined : caller.projectId)
          .pipe(Effect.mapError((e) => new InvalidCaller({ method: "Integration.Guard", message: String(e) })))
        const answer = definition.guardAnswer === undefined ? reason : definition.guardAnswer(reason)
        return answer === undefined ? {} : { answer }
      }),
  }
})
