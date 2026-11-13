import { messageOf } from "@vibest/schema/error"
import { Config, Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

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
      () => new Error(`no vibest release is published there yet`),
    ),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(read),
    Effect.map((v) => v.trim()),
    Effect.filterOrFail(isSemver, (v) => new Error(`not a semver version: ${JSON.stringify(v)}`)),
    Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(new Error("no answer")) }),
    Effect.mapError((e) => new UpdateError({ message: `could not read ${url}: ${messageOf(e)}` })),
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
