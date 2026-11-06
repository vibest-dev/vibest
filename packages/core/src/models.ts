import { Config, Effect, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { type HarnessAdapter, Harnesses, HARNESS_IDS, type HarnessId, HarnessUnavailable } from "./harness.ts"

export const Model = Schema.Struct({
  harness: Schema.Literals(HARNESS_IDS),
  provider: Schema.NullOr(Schema.String),
  model: Schema.String,
  name: Schema.String,
  description: Schema.String,
  default: Schema.Boolean,
})
export type Model = typeof Model.Type

export interface RawModel {
  readonly model: string
  readonly provider?: string | undefined
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly default: boolean
}

export interface ModelLister {
  readonly args: (provider: string | null) => ReadonlyArray<string>
  readonly request?: string
  readonly answer: (lines: ReadonlyArray<string>) => ReadonlyArray<RawModel> | undefined
}

export const normalizeModels = (
  harness: HarnessId,
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

export const jsonLines = (...messages: ReadonlyArray<unknown>) => messages.map((m) => `${JSON.stringify(m)}\n`).join("")

export const findMessage = <A>(schema: Schema.Codec<A, unknown>) => {
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema))
  return (lines: ReadonlyArray<string>): A | undefined => {
    for (const line of lines) {
      const r = decode(line)
      if (r._tag === "Some") return r.value
    }
    return undefined
  }
}

export const withConfigured = (
  models: ReadonlyArray<RawModel>,
  configured: Omit<RawModel, "default"> | undefined,
): ReadonlyArray<RawModel> =>
  models.some((m) => m.default) || !configured ? models : [...models, { ...configured, default: true }]

export const listModels = Effect.fn("listModels")(function* (adapter: HarnessAdapter, provider: string | null) {
  const { id, binary, checkProvider, models: lister } = adapter
  const unavailable = (message: string) => new HarnessUnavailable({ harness: id, message })
  const providerError = checkProvider(provider)
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
      ChildProcess.make(binary, lister.args(provider), { stdin, cwd, env: { HOME: cwd }, extendEnv: true }),
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

export const listAllModels = (harnesses: ReadonlyArray<HarnessId>, provider: string | null) =>
  Effect.forEach(
    harnesses,
    (h) => Effect.result(Effect.flatMap(Harnesses, (all) => listModels(all.get(h), provider))),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((results) => ({
      models: results.flatMap((r) => (r._tag === "Success" ? r.success : [])),
      errors: results.flatMap((r) => (r._tag === "Failure" ? [`${r.failure.harness}: ${r.failure.message}`] : [])),
    })),
  )
