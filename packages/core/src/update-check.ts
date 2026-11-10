import { type UpdateStatus, VERSION } from "@vibest/protocol/rpc"
import { Clock, Config, Context, Duration, Effect, Exit, Layer, Option, Ref, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"

import { LayerNode } from "./effect/layer-node.ts"
import { VibestCommand } from "./paths.ts"

export class UpdateError extends Schema.TaggedError<UpdateError>()("UpdateError", { message: Schema.String }) {}

export const isSemver = (v: string) =>
  /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(v)

const RELEASES = "https://github.com/vibest-dev/vibest/releases/latest/download"

export const releasesUrl = Effect.gen(function* () {
  return (yield* Config.String("VIBEST_DOWNLOAD_URL").pipe(Config.withDefault(RELEASES))).replace(/\/+$/, "")
})

export const installMethod = (self: ReadonlyArray<string>, harnesses: string | undefined) => {
  if (harnesses) return { kind: "npm" } as const
  const m = self.length === 1 ? /^(.+)\/versions\/[^/]+\/bin\/vibest$/.exec(self[0]!) : null
  return m ? ({ kind: "curl", share: m[1]! } as const) : undefined
}
export type InstallMethod = NonNullable<ReturnType<typeof installMethod>>

const latestVersion = (
  url: string,
  read: (body: HttpClientResponse.HttpClientResponse) => Effect.Effect<string, unknown>,
) =>
  HttpClient.get(url).pipe(
    Effect.filterOrFail(
      (r) => r.status !== 404,
      () => new Error(`no vibest release is published there yet; this vibest ${VERSION} stays as it is`),
    ),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(read),
    Effect.map((v) => v.trim()),
    Effect.filterOrFail(isSemver, (v) => new Error(`not a semver version: ${JSON.stringify(v)}`)),
    Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(new Error("no answer")) }),
    Effect.mapError(
      (e) => new UpdateError({ message: `could not read ${url}: ${e instanceof Error ? e.message : String(e)}` }),
    ),
    Effect.provide(FetchHttpClient.layer),
  )

const npmLatest = Effect.gen(function* () {
  const registry = yield* Config.String("npm_config_registry").pipe(Config.withDefault("https://registry.npmjs.org"))
  return yield* latestVersion(`${registry.replace(/\/+$/, "")}/@vibest/cli/beta`, (r) =>
    Effect.map(HttpClientResponse.schemaBodyJson(Schema.Struct({ version: Schema.String }))(r), (b) => b.version),
  )
})

export const latestOf = (method: InstallMethod) =>
  method.kind === "npm"
    ? npmLatest
    : Effect.flatMap(releasesUrl, (releases) => latestVersion(`${releases}/version`, (r) => r.text))

export const UPDATE_CHECK_EVERY = Duration.hours(1)

export const NOT_CHECKED: UpdateStatus = { checked: null, latest: null, checking: false }

export const UpdateCheck = Context.Reference<Effect.Effect<UpdateStatus>>("vibest/UpdateCheck", {
  defaultValue: () => Effect.succeed(NOT_CHECKED),
})

export const checkEveryHour = (lookup: Effect.Effect<string, unknown>) =>
  Effect.gen(function* () {
    const status = yield* Ref.make(NOT_CHECKED)
    const check = Effect.gen(function* () {
      yield* Ref.update(status, (s) => ({ ...s, checking: true }))
      const found = yield* Effect.exit(lookup)
      const now = yield* Clock.currentTimeMillis
      yield* Ref.update(status, (s) =>
        Exit.isSuccess(found)
          ? { checked: now, latest: found.value, checking: false }
          : { ...s, checked: null, checking: false },
      )
    })
    yield* Effect.forkScoped(Effect.repeat(check, Schedule.spaced(UPDATE_CHECK_EVERY)))
    return Ref.get(status)
  })

export const layer = Layer.effect(
  UpdateCheck,
  Effect.gen(function* () {
    if (Option.isSome(yield* Config.option(Config.String("VIBEST_NO_UPDATE_CHECK")))) return Effect.succeed(NOT_CHECKED)
    const method = installMethod(
      yield* VibestCommand,
      Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_HARNESSES"))),
    )
    if (!method) return Effect.succeed(NOT_CHECKED)
    return yield* checkEveryHour(latestOf(method))
  }).pipe(Effect.orDie),
)

export const node = LayerNode.make({ service: UpdateCheck, layer, deps: [] })
