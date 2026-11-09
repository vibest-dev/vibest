import * as Guard from "@vibest/core/guard"
import { harnessCatalog, Harnesses, unprovided } from "@vibest/core/harness"
import { forProvider } from "@vibest/core/models"
import { Layout } from "@vibest/core/paths"
import { Caller, InvalidCaller } from "@vibest/protocol/rpc"
import { ConfigProvider, Effect } from "effect"

export const integrationHandlers = Effect.gen(function* () {
  const harnesses = yield* Harnesses
  const layout = yield* Layout
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
        const own = caller._tag === "Cli" ? {} : { VIBEST_PROJECT_DIR: layout.project(caller.projectId) }
        const reason = yield* Guard.check(agent, input).pipe(
          Effect.provideService(Harnesses, harnesses),
          Effect.provide(ConfigProvider.layerAdd(ConfigProvider.fromEnv({ env: own }), { asPrimary: true })),
          Effect.mapError((e) => new InvalidCaller({ method: "Integration.Guard", message: String(e) })),
        )
        const answer = definition.guardAnswer === undefined ? reason : definition.guardAnswer(reason)
        return answer === undefined ? {} : { answer }
      }),
  }
})
