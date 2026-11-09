import { Config, Context, Effect, Layer, Path } from "effect"

export class Layout extends Context.Service<
  Layout,
  {
    readonly home: string
    readonly database: string
    readonly socket: string
    readonly httpSocket: string
    readonly daemonInfo: string
    readonly identity: string
    readonly worktrees: string
    readonly projects: string
    readonly config: string
    readonly plugins: string
    readonly allocationWorktree: (repository: string, name: string) => string
    readonly project: (projectId: string) => string
    readonly artifacts: (projectId: string) => string
  }
>()("vibest/Layout") {
  static readonly make = (home: string) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      return Layout.of({
        home,
        database: path.join(home, "vibest.db"),
        socket: path.join(home, "vibest.sock"),
        httpSocket: path.join(home, "vibest-http.sock"),
        daemonInfo: path.join(home, "vibestd.pid"),
        identity: path.join(home, "identity.json"),
        worktrees: path.join(home, "worktrees"),
        projects: path.join(home, "projects"),
        config: path.join(home, "vibest.json"),
        plugins: path.join(home, "plugins"),
        allocationWorktree: (repository, name) => path.join(home, "worktrees", repository, name),
        project: (projectId) => path.join(home, "projects", projectId),
        artifacts: (projectId) => path.join(home, "projects", projectId, "artifacts"),
      })
    })

  static readonly layer = Layer.effect(
    Layout,
    Effect.gen(function* () {
      const path = yield* Path.Path
      const home = yield* Config.String("VIBEST_HOME").pipe(
        Config.orElse(() => Config.String("HOME").pipe(Config.map((h) => path.join(h, ".vibest")))),
      )
      return yield* Layout.make(home)
    }),
  )
}

export const VibestCommand = Context.Reference<ReadonlyArray<string>>("vibest/VibestCommand", {
  defaultValue: () => ["vibest"],
})

export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
