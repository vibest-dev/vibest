// The harnesses this binary runs itself, without vibestd: `vibest models`, `vibest harness list`, `vibest doctor`, and
// the main agent's own exec (launch.ts). The command line reaches them only through here, never through the engine.
import { Harness, Harnesses, type HarnessId, preflight } from "@vibest/core/harness"
import * as BuiltinHarnesses from "@vibest/core/harnesses"
import { listAllModels } from "@vibest/core/models"
import { Effect } from "effect"

/** This binary's built-in harness adapters (vibestd adds the plugins' on top). */
export const builtins = BuiltinHarnesses.layer

/** The harnesses this binary knows without vibestd (its built-ins); plugin harnesses are vibestd's. */
export const builtinIds = Effect.gen(function* () {
  return (yield* Harnesses).all().map((a) => a.id)
})

/** What each of `harnesses` reports it accepts, with `provider` only; the ones that could not answer under `errors`. */
export const models = (harnesses: ReadonlyArray<HarnessId>, provider: string | null) =>
  listAllModels(harnesses, provider)

/** Each harness: its binary, whether it is on PATH, and the model it runs by default (or why it could not be asked). */
export const summaries = (ids: ReadonlyArray<HarnessId>) =>
  Effect.forEach(
    ids,
    (h) =>
      Effect.gen(function* () {
        const host = yield* Harness
        const summary = { harness: h, binary: (yield* Harnesses).get(h).binary }
        if (!(yield* host.available(h)))
          return { ...summary, available: false, defaultModel: null, error: `${summary.binary} is not on PATH` }
        return yield* host.models(h, null).pipe(
          Effect.map((models) => ({
            ...summary,
            available: true,
            defaultModel: models.find((m) => m.default)?.model ?? null,
            error: null,
          })),
          Effect.catchTag("HarnessUnavailable", (e) =>
            Effect.succeed({ ...summary, available: true, defaultModel: null, error: e.message }),
          ),
        )
      }),
    { concurrency: "unbounded" },
  ).pipe(Effect.provide(Harness.layer))

/** Whether `id` could run a session now: its models, or what keeps it from running. */
export const check = (id: HarnessId) =>
  preflight(id, null, null).pipe(
    Effect.map((models) => ({ ok: true as const, models })),
    Effect.catchTag("HarnessUnavailable", (e) => Effect.succeed({ ok: false as const, message: e.message })),
    Effect.provide(Harness.layer),
  )

/** Run `effect` with this machine's harness binaries (what launch.ts needs to exec the main agent). */
export const local = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(Harness.layer))
