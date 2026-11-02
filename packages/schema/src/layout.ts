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
    readonly results: string
    /** `reports/<id>.jsonl`: one line per turn start and turn end the harness integration writes (runtime-port.md §5). */
    readonly reports: string
    readonly worktrees: string
    readonly projects: string
    /** vibest.json: the plugin list (plugins.md §4). */
    readonly config: string
    /** Plugins found by directory listing. */
    readonly plugins: string
    readonly resultFile: (id: string) => string
    /** One turn report line file: `reports/<id>.jsonl`, appended by the integrations. */
    readonly reportFile: (id: string) => string
    readonly rulesFile: (id: string) => string
    /** The Coordinator's rules for one repository, rewritten on every `vibest`. */
    readonly coordinatorRules: (key: string) => string
    /** `worktrees/<id>`, when the owner has no recorded allocation. */
    readonly legacyWorktree: (id: string) => string
    /** `worktrees/<repository>/<name>`. `name` is the recorded 4-hex leaf, not the session id. */
    readonly allocationWorktree: (repository: string, name: string) => string
    readonly project: (key: string) => string
    readonly scratch: (key: string) => string
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
        results: path.join(home, "results"),
        reports: path.join(home, "reports"),
        worktrees: path.join(home, "worktrees"),
        projects: path.join(home, "projects"),
        config: path.join(home, "vibest.json"),
        plugins: path.join(home, "plugins"),
        resultFile: (id) => path.join(home, "results", `${id}.json`),
        reportFile: (id) => path.join(home, "reports", `${id}.jsonl`),
        rulesFile: (id) => path.join(home, "rules", `${id}.md`),
        coordinatorRules: (key) => path.join(home, "coordinator", `${key}.md`),
        legacyWorktree: (id) => path.join(home, "worktrees", id),
        allocationWorktree: (repository, name) => path.join(home, "worktrees", repository, name),
        project: (key) => path.join(home, "projects", key),
        scratch: (key) => path.join(home, "projects", key, "scratch"),
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
