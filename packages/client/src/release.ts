import { messageOf } from "@vibest/schema/error"
import { Config, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

export class UpdateError extends Schema.TaggedError<UpdateError>()("UpdateError", { message: Schema.String }) {}

export const isSemver = (v: string) =>
  /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(v)

export const compareVersions = (a: string, b: string) => {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/\+.*/, "").split(/-(.*)/)

    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] }
  }

  const x = parse(a)
  const y = parse(b)

  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return (x.core[i] ?? 0) - (y.core[i] ?? 0)

  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length

  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]]

    if (p === q) continue

    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    const [m, n] = [/^\d+$/.test(p), /^\d+$/.test(q)]

    if (m && n) return Number(p) - Number(q)

    return m !== n ? (m ? -1 : 1) : p < q ? -1 : 1
  }

  return 0
}

export type Channel = "stable" | "beta"

export const channelOf = (version: string): Channel => (version.includes("-") ? "beta" : "stable")

const isStable = (v: string) => /^\d+\.\d+\.\d+$/.test(v)
const isRelease = (v: string) => /^\d+\.\d+\.\d+(-beta\.\d+)?$/.test(v)

export const newestIn = (channel: Channel, versions: ReadonlyArray<string>) =>
  versions
    .filter(channel === "stable" ? isStable : isRelease)
    .reduce<string | undefined>((a, v) => (a === undefined || compareVersions(v, a) > 0 ? v : a), undefined)

const GITHUB_RELEASES = "https://github.com/vibest-dev/vibest/releases"

export const installMethod = (self: ReadonlyArray<string>, harnesses: string | undefined) => {
  if (harnesses) return { kind: "npm" } as const
  const m = self.length === 1 ? /^(.+)\/versions\/[^/]+\/bin\/vibest$/.exec(self[0]!) : null

  return m ? ({ kind: "curl", share: m[1]! } as const) : undefined
}

export type InstallMethod = NonNullable<ReturnType<typeof installMethod>>

const read = <A>(url: string, body: (r: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, unknown>) =>
  HttpClient.get(url).pipe(
    Effect.filterOrFail(
      (r) => r.status !== 404,
      () => new Error(`no vibest release is published there yet`),
    ),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(body),
    Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(new Error("no answer")) }),
    Effect.mapError((e) => new UpdateError({ message: `could not read ${url}: ${messageOf(e)}` })),
  )

const text = (r: HttpClientResponse.HttpClientResponse) => r.text

const newestOrFail = (channel: Channel, url: string, versions: ReadonlyArray<string>) => {
  const version = newestIn(channel, versions)

  if (version !== undefined) return Effect.succeed(version)
  const found = versions.length ? `it names ${versions.join(", ")}` : "it names none"

  return Effect.fail(
    new UpdateError({
      message:
        channel === "stable"
          ? `no stable vibest release yet (${url}: ${found}); the newest beta: vibest update --beta`
          : `no vibest release at ${url} (${found})`,
    }),
  )
}

const npmLatest = (channel: Channel) =>
  Effect.gen(function* () {
    const registry = yield* Config.String("npm_config_registry").pipe(Config.withDefault("https://registry.npmjs.org"))
    const url = `${registry.replace(/\/+$/, "")}/-/package/@vibest/cli/dist-tags`
    const tags = yield* read(url, HttpClientResponse.schemaBodyJson(Schema.Record(Schema.String, Schema.String)))
    const named = [tags.latest, ...(channel === "beta" ? [tags.beta] : [])].filter((v) => v !== undefined)

    return { kind: "npm", version: yield* newestOrFail(channel, url, named) } as const
  })

const pinnedRelease = (releases: string) =>
  read(`${releases}/version`, text).pipe(
    Effect.map((v) => v.trim()),
    Effect.filterOrFail(
      isSemver,
      (v) => new UpdateError({ message: `${releases}/version is not a semver version: ${JSON.stringify(v)}` }),
    ),
    Effect.map((version) => ({ kind: "curl", version, releases }) as const),
  )

const githubLatest = (channel: Channel, root: string) =>
  Effect.gen(function* () {
    const url = channel === "stable" ? `${root}/latest/download/version` : `${root}.atom`
    const listed = yield* read(url, text)

    const versions =
      channel === "stable" ? [listed.trim()] : [...listed.matchAll(/\/releases\/tag\/v([^"<\s]+)/g)].map((m) => m[1]!)

    const version = yield* newestOrFail(channel, url, versions)

    return { kind: "curl", version, releases: `${root}/download/v${version}` } as const
  })

const curlLatest = (channel: Channel) =>
  Effect.gen(function* () {
    const pinned = yield* Config.option(Config.String("VIBEST_DOWNLOAD_URL"))

    if (Option.isSome(pinned) && pinned.value !== "") return yield* pinnedRelease(pinned.value.replace(/\/+$/, ""))
    const root = yield* Config.String("VIBEST_RELEASES_URL").pipe(Config.withDefault(GITHUB_RELEASES))

    return yield* githubLatest(channel, root.replace(/\/+$/, ""))
  })

export const latestOf = (method: InstallMethod, channel: Channel) =>
  Effect.gen(function* () {
    return method.kind === "npm" ? yield* npmLatest(channel) : yield* curlLatest(channel)
  })
