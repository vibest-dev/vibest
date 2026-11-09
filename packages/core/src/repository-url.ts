import { Context, Duration, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

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
  const m = /^(?:[^@/:]+@)?([^/:@]+):(.+)$/.exec(u)
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
          const line = code === 0 ? out.split("\n").find((l) => l.startsWith("hostname ")) : undefined
          return line?.slice("hostname ".length).trim() || alias
        }).pipe(
          Effect.scoped,
          Effect.timeoutOption(Duration.seconds(5)),
          Effect.map((found) => (found._tag === "Some" ? found.value : alias)),
          Effect.orElseSucceed(() => alias),
        )
      return {
        hostName: (alias) => {
          const hit = known.get(alias)
          return hit !== undefined
            ? Effect.succeed(hit)
            : Effect.tap(ask(alias), (name) => Effect.sync(() => known.set(alias, name)))
        },
      }
    }),
  )
}

export const repositoryIdentity = (url: string) =>
  Effect.gen(function* () {
    const remote = parseRemote(url)
    if (remote === undefined) return undefined
    const host = remote.ssh ? yield* (yield* SshHosts).hostName(remote.host) : remote.host
    return `${host.toLowerCase()}/${remote.path}`
  })
