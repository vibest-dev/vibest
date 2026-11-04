// ~/.vibest layout (SPEC §5.1): where the daemon and its clients find each other.
import { Config, Context, Effect, Layer, Path } from "effect"

export class Layout extends Context.Service<
  Layout,
  {
    readonly home: string
    readonly database: string
    readonly socket: string
    /** vibestd's HTTP socket (the Claude plugin's poll, ack and hooks). */
    readonly httpSocket: string
    /** vibestd.pid: the running vibestd's PID and version (DaemonInfo), and its start lock (flock on this file); empty when none runs. */
    readonly daemonInfo: string
    readonly worktrees: string
    readonly projects: string
    /** vibest.json: the plugin list (plugins.md §4). */
    readonly config: string
    /** Plugins found by directory listing. */
    readonly plugins: string
    /** `worktrees/<repository>/<name>`. `name` is the recorded 4-hex leaf, not the session id. */
    readonly allocationWorktree: (repository: string, name: string) => string
    /** `projects/<project id>`: the project's docs, memory, scratch and instructions.md. */
    readonly project: (projectId: string) => string
    readonly scratch: (projectId: string) => string
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
        worktrees: path.join(home, "worktrees"),
        projects: path.join(home, "projects"),
        config: path.join(home, "vibest.json"),
        plugins: path.join(home, "plugins"),
        allocationWorktree: (repository, name) => path.join(home, "worktrees", repository, name),
        project: (projectId) => path.join(home, "projects", projectId),
        scratch: (projectId) => path.join(home, "projects", projectId, "scratch"),
      })
    })

  /** VIBEST_HOME, default `$HOME/.vibest`. */
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

/** argv that runs this vibest again (`bun <script>` from source, the binary itself when compiled). Provided by the entry. */
export const VibestCommand = Context.Reference<ReadonlyArray<string>>("vibest/VibestCommand", {
  defaultValue: () => ["vibest"],
})

/** One POSIX shell word for `s` (ponytail: fish reads backslashes inside quotes as escapes). */
export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
