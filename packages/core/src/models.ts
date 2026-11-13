import type { Harness as PluginHarness } from "@vibest/plugin/effect"
import type { HarnessChoice } from "@vibest/schema/session"
import { HarnessUnavailable } from "@vibest/schema/session"
import { Config, Effect, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import type { HarnessDefinition } from "./host.ts"

export const Model = Schema.Struct({
  harness: Schema.String,
  provider: Schema.NullOr(Schema.String),
  model: Schema.String,
  name: Schema.String,
  description: Schema.String,
  default: Schema.Boolean,
})
export type Model = typeof Model.Type

export type RawModel = PluginHarness.RawModel
export type ModelLister = PluginHarness.ModelLister

export const normalizeModels = (
  harness: string,
  provider: string | null,
  raw: ReadonlyArray<RawModel>,
): ReadonlyArray<Model> =>
  raw
    .map((r) => ({
      harness,
      provider: r.provider ?? provider,
      model: r.model,
      name: r.name || r.model,
      description: r.description ?? "",
      default: r.default,
    }))
    .filter((m) => !provider || m.provider === provider)

export const listModels = Effect.fn("listModels")(function* (
  adapter: HarnessDefinition,
  provider: string | null,
  env?: Readonly<Record<string, string>>,
) {
  const { id, binary, checkProvider, models: lister } = adapter
  const unavailable = (message: string) => new HarnessUnavailable({ harness: id, message })
  const providerError = checkProvider?.(provider)
  if (providerError) return yield* unavailable(providerError)
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const cwd = yield* Config.String("HOME").pipe(Config.withDefault(""), Effect.orDie)
  const problem = yield* adapter.checkEnvironment?.(cwd) ?? Effect.succeed(undefined)
  if (problem) return yield* unavailable(problem)
  const stdin =
    lister.request === undefined
      ? "ignore"
      : Stream.concat(Stream.make(new TextEncoder().encode(lister.request)), Stream.never)
  const lines = yield* spawner
    .streamLines(
      ChildProcess.make(binary, lister.args(provider), {
        stdin,
        cwd,
        env: { HOME: cwd, ...env },
        extendEnv: true,
      }),
      {
        includeStderr: true,
      },
    )
    .pipe(
      Stream.scan(
        (): ReadonlyArray<string> => [],
        (seen, line) => [...seen, line],
      ),
      lister.request === undefined ? (s) => s : Stream.takeUntil((seen) => lister.answer(seen) !== undefined),
      Stream.runLast,
      Effect.map(Option.getOrElse((): ReadonlyArray<string> => [])),
      Effect.timeout("30 seconds"),
      Effect.mapError((e) => unavailable(`${binary} did not list its models: ${e.message}`)),
    )
  const raw = lister.answer(lines)
  if (!raw) {
    const last = lines.findLast((l) => l.trim())?.trim()
    return yield* unavailable(`${binary} gave no model list${last ? `: ${last}` : ""}`)
  }
  const models = normalizeModels(id, provider, raw)
  if (models.length === 0)
    return yield* unavailable(`${binary} lists no models${provider ? ` for provider "${provider}"` : ""}`)
  return models
})

export const forProvider = (
  choices: ReadonlyArray<HarnessChoice>,
  definitions: { readonly find: (id: string) => Pick<HarnessDefinition, "checkProvider"> | undefined },
  provider: string,
): ReadonlyArray<HarnessChoice> =>
  choices.map((c) => {
    if (c.problem !== null) return c
    const refused = definitions.find(c.harness)?.checkProvider?.(provider)
    if (refused !== undefined) return { ...c, problem: refused, models: [] }
    const models = c.models.filter((m) => m.provider === provider)
    return models.length === 0
      ? { ...c, problem: `${c.binary} lists no models for provider "${provider}"`, models: [] }
      : { ...c, models }
  })
