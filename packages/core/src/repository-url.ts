import { Context, Duration, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { LayerNode } from "./effect/layer-node.ts"
import * as PlatformNode from "./effect/platform.ts"

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

export class SshHosts extends Context.Service<
  SshHosts,
  { readonly hostName: (alias: string) => Effect.Effect<string> }
>()("vibest/SshHosts") {
  static readonly layer = Layer.effect(
    SshHosts,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const known = new Map<string, string>()
      const ask = (alias: string) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("ssh", ["-G", "--", alias]))
          const [out, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
            concurrency: "unbounded",
          })
          const name = out
            .split("\n")
            .find((line) => line.startsWith("hostname "))
            ?.slice("hostname ".length)
            .trim()
          if (code !== 0 || !name) return alias
          known.set(alias, name)
          return name
        }).pipe(
          Effect.scoped,
          Effect.timeout(Duration.seconds(5)),
          Effect.orElseSucceed(() => alias),
        )
      return {
        hostName: (alias) => {
          const hit = known.get(alias)
          return hit === undefined ? ask(alias) : Effect.succeed(hit)
        },
      }
    }),
  )

  static readonly node = LayerNode.make({
    service: SshHosts,
    layer: SshHosts.layer,
    deps: [PlatformNode.childProcessSpawner],
  })
}

export const repositoryIdentity = (url: string) =>
  Effect.gen(function* () {
    const remote = parseRemote(url)
    if (remote === undefined) return undefined
    const host = remote.ssh ? yield* (yield* SshHosts).hostName(remote.host) : remote.host
    return `${host.toLowerCase()}/${remote.path}`
  })
