import { Host } from "@vibest/plugin/host"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Duration, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"

import { PlatformNode } from "./effect/platform.ts"

export * as RepositoryUrl from "./repository-url.ts"

export type ParsedRemote = { readonly host: string; readonly path: string; readonly ssh: boolean }

const parsed = (host: string, rest: string, ssh: boolean): ParsedRemote | undefined => {
  const path = rest
    .replace(/^~?\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")

  return path === "" ? undefined : { host, path, ssh }
}

export const parseRemote = (url: string): ParsedRemote | undefined => {
  const u = url.trim()

  if (u.includes("://")) {
    const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:@]+)(?::\d*)?\/(.+)$/i.exec(u)

    return m === null || /^file$/i.test(m[1]!) ? undefined : parsed(m[2]!, m[3]!, /ssh/i.test(m[1]!))
  }

  const m = /^(?:[^@/:]+@)?([^/:@[\]]{2,}):(.+)$/.exec(u)

  return m === null ? undefined : parsed(m[1]!, m[2]!, true)
}

const REMOTE_KEY = /^remote\.(\S+)\.(url|gh-resolved)(?: (.*))?$/

const parseRemoteConfig = (config: string) => {
  const urls = new Map<string, string>()
  const marked = new Set<string>()

  for (const line of config.split("\n")) {
    const m = REMOTE_KEY.exec(line.trim())

    if (m === null) continue
    const [, name, key, value = ""] = m

    if (key === "gh-resolved") {
      const trimmed = value.trim()

      if (trimmed !== "" && trimmed.toLowerCase() !== "false") marked.add(name!)
    } else if (!urls.has(name!)) urls.set(name!, value)
  }

  return { names: [...urls.keys()], marked }
}

const remoteRank = (marked: ReadonlySet<string>, name: string) =>
  marked.has(name) ? 0 : name === "upstream" ? 1 : name === "origin" ? 2 : 3

export const rankedRemotes = (config: string): ReadonlyArray<string> => {
  const { names, marked } = parseRemoteConfig(config)

  return names.sort((a, b) => remoteRank(marked, a) - remoteRank(marked, b) || a.localeCompare(b))
}

const projectRemoteRank = (marked: ReadonlySet<string>, name: string) =>
  name === "origin" ? 0 : marked.has(name) ? 1 : 2

export const projectRemotes = (config: string): ReadonlyArray<string> => {
  const { names, marked } = parseRemoteConfig(config)

  return names.sort((a, b) => projectRemoteRank(marked, a) - projectRemoteRank(marked, b))
}

export interface Interface {
  readonly hostName: (alias: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("vibest/SshHosts") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const known = new Map<string, string>()

    const ask = (alias: string) =>
      Host.capture("ssh", ["-G", "--", alias], { timeout: Duration.seconds(5) }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.map((run) => {
          if (run === undefined || run.exitCode !== 0) return alias

          const name = run.stdout
            .split("\n")
            .find((line) => line.startsWith("hostname "))
            ?.slice("hostname ".length)
            .trim()

          if (!name) return alias
          known.set(alias, name)

          return name
        }),
        Effect.orElseSucceed(() => alias),
      )

    return {
      hostName: Effect.fn("RepositoryUrl.hostName")((alias) => {
        const hit = known.get(alias)

        return hit === undefined ? ask(alias) : Effect.succeed(hit)
      }),
    }
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [PlatformNode.childProcessSpawner],
})

export const repositoryIdentity = Effect.fn("RepositoryUrl.repositoryIdentity")(function* (url: string) {
  const remote = parseRemote(url)

  if (remote === undefined) return undefined
  const host = remote.ssh ? yield* (yield* Service).hostName(remote.host) : remote.host

  return `${host.toLowerCase()}/${remote.path}`
})
