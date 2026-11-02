// Finding, importing and watching plugins (plugins.md §4), aligned with OpenCode V2's config/plugin/source.ts,
// plugin/module.ts and plugin/src/source.ts. Only the user's VIBEST_HOME counts: `plugins/`, then `vibest.json`.
import type * as VibestPlugin from "@vibest/plugin"
import { Context, Crypto, Duration, Effect, FileSystem, Option, Path, Schema } from "effect"
import { Hex } from "effect/encoding"
import { checkPlugin } from "./check.ts"
import { Layout } from "./paths.ts"

/** What vibestd needs from the runtime to load plugins: `prepare` maps `effect` and `@vibest/plugin` to vibestd's own instances and keys each load's local imports. */
export class PluginLoader extends Context.Service<PluginLoader, {
  readonly prepare: Effect.Effect<void>
  readonly parseJsonc: (text: string) => unknown
  /** `entry` and the local files it imports, transitively, outside node_modules; `unresolved`: directories of local imports that do not resolve (yet). */
  readonly graph: (entry: string) => { readonly files: ReadonlyArray<string>; readonly unresolved: ReadonlyArray<string> }
  /** Import `entry` afresh, after dropping `files` from the module registry; rejects with what loading throws. */
  readonly load: (entry: string, files: ReadonlyArray<string>) => Promise<unknown>
  /** Watch `directory` (not recursively), calling `changed` with the name of each entry that changes; watching once this returns. Returns the stop. */
  readonly watch: (directory: string, changed: (name: string) => void) => () => void
}>()("vibest/PluginLoader") {}

/** A plugin as found and imported, before setup: the module's default export, or why there is none. */
export interface Candidate {
  readonly source: string
  readonly revision: string
  readonly options: Readonly<Record<string, unknown>>
  readonly plugin: VibestPlugin.Plugin.Plugin | { readonly error: string }
}

/** What a read depended on: a change to one of these may change the plugins. */
export interface Watched {
  /** Files and directories whose creation, change or removal matters. */
  readonly paths: ReadonlySet<string>
  /** Directories where any entry matters: `plugins/`, directory plugins, directories of unresolved imports. */
  readonly listings: ReadonlySet<string>
}

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

const ConfigEntry = Schema.Union([Schema.String, Schema.Struct({ package: Schema.String, options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) })])
const ConfigFile = Schema.Struct({ plugins: Schema.optional(Schema.Array(ConfigEntry)) })
type ConfigFile = typeof ConfigFile.Type
const PluginModule = Schema.Struct({
  default: Schema.Struct({
    id: Schema.String,
    effect: Schema.declare<VibestPlugin.Plugin.Plugin["effect"]>((u): u is VibestPlugin.Plugin.Plugin["effect"] => typeof u === "function"),
  }),
})

type Operation = { readonly type: "add"; readonly target: string; readonly options: Readonly<Record<string, unknown>> } | { readonly type: "remove"; readonly target: string }

const SOURCE = /\.[cm]?[jt]s$/
const isLocal = (target: string) => target.startsWith("/") || target.startsWith("./") || target.startsWith("../") || target.startsWith("file://")
/** `*` matches everything, `x.*` every id starting with `x.`. */
const matches = (selector: string, id: string) => selector === "*" || (selector.endsWith(".*") ? id.startsWith(selector.slice(0, -1)) : selector === id)

/** Entries of `plugins/` that are plugins, sorted by path: sources, and directories with an entry file. */
export const pluginEntries = (names: ReadonlyArray<string>) =>
  names.filter((n) => n !== "node_modules" && !n.startsWith(".") && !n.endsWith(".d.ts")).sort()

type Graph = ReturnType<PluginLoader["Service"]["graph"]>
/** An import of one entry: the file it really is, the local graph it read, that graph's revision, and what came of it. */
type Imported = { readonly real: string; readonly graph: Graph; readonly revision: string; readonly plugin: Candidate["plugin"] }

/**
 * Reads the plugin list. Imports are cached by the content digests of the entry's local graph: an unchanged graph is
 * not imported again, failed or not (OpenCode V2), so unrelated saves never repeat a broken plugin's import-time effects.
 */
export const makeSources = Effect.fnUntraced(function* (timeout: Duration.Input) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const layout = yield* Layout
  const loader = yield* PluginLoader
  const imported = new Map<string, Imported>()
  /** A half-saved vibest.json must not unload every configured plugin: keep the last one that parsed. */
  let lastConfig: ConfigFile = { plugins: [] }

  const sha = (bytes: Uint8Array) => crypto.digest("SHA-256", bytes).pipe(Effect.map(Hex.encode))
  const utf8 = (s: string) => new TextEncoder().encode(s)
  const isDirectory = (target: string) => fs.stat(target).pipe(Effect.map((i) => i.type === "Directory"), Effect.orElseSucceed(() => false))
  /** A digest of the graph's file contents and of the listings of its unresolved import directories ("missing" when gone). */
  const revisionOf = (graph: Graph) =>
    Effect.forEach([...graph.files.map((f) => [f, false] as const), ...graph.unresolved.map((d) => [d, true] as const)], ([target, listing]) =>
      (listing ? fs.readDirectory(target).pipe(Effect.flatMap((names) => sha(utf8([...names].sort().join("\n"))))) : fs.readFile(target).pipe(Effect.flatMap(sha))).pipe(
        Effect.orElseSucceed(() => "missing"),
        Effect.map((digest) => `${target}\0${digest}`),
      ),
    ).pipe(Effect.flatMap((lines) => sha(utf8(lines.join("\n")))), Effect.map((hex) => hex.slice(0, 12)))

  /** A source file is its own entry; a directory's is `server.*`, else `index.*` (OpenCode `plugin/src/host.ts`). */
  const entry = Effect.fn(function* (target: string) {
    // A file that cannot be read (a dangling link) is still its own entry: importing it reports why.
    if (!(yield* isDirectory(target))) return target
    for (const name of ["server", "index"]) {
      for (const ext of [".ts", ".js", ".mts", ".mjs"]) {
        const file = path.join(target, name + ext)
        if (yield* fs.exists(file)) return file
      }
    }
    return undefined
  })

  /**
   * The file `file` really is, so imports resolve next to the real file and Bun never sees two paths for one module (its
   * resolver keeps failing for files added later under a symlinked directory, such as /var on macOS). A dangling link
   * gives the path it points at, watched until it appears.
   */
  const canonical = (file: string) =>
    fs.realPath(file).pipe(
      Effect.catch(() => fs.readLink(file).pipe(Effect.map((target) => path.resolve(path.dirname(file), target)))),
      Effect.orElseSucceed(() => file),
    )

  const importEntry = Effect.fn(function* (file: string) {
    const previous = imported.get(file)
    const real = yield* canonical(file)
    if (previous !== undefined && previous.real === real && (yield* revisionOf(previous.graph)) === previous.revision) return previous
    // ponytail: node_modules is neither watched nor evicted (plugins.md §4): a missing dependency, once installed, is retried
    // only when this plugin's own graph changes; an upgraded dependency that was already loaded needs an vibestd restart.
    const graph = yield* Effect.try(() => loader.graph(real)).pipe(Effect.orElseSucceed((): Graph => ({ files: [real], unresolved: [] })))
    const revision = yield* revisionOf(graph)
    const forget = [...new Set([...graph.files, ...(previous?.graph.files ?? [])])]
    // A top-level await that never settles must not hold the reload: give up after `timeout`, like a setup.
    const module = yield* Effect.tryPromise({ try: () => loader.load(real, forget), catch: (e) => `import failed: ${messageOf(e)}` }).pipe(
      Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(`import timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}`) }),
      Effect.flatMap((m) => Schema.decodeUnknownEffect(PluginModule)(m).pipe(Effect.mapError(() => "must export default Plugin.define({ id, effect })"))),
      Effect.result,
    )
    const result: Imported = { real, graph, revision, plugin: module._tag === "Failure" ? { error: module.failure } : module.success.default }
    imported.set(file, result)
    return result
  })

  const load = (target: string, options: Readonly<Record<string, unknown>>, paths: Set<string>, listings: Set<string>) =>
    Effect.gen(function* () {
      const failed = (error: string, revision = "-"): Candidate => ({ source: target, revision, options, plugin: { error } })
      // Builtin, and off until this entry configures it (architecture.md §4.3). Not an npm package.
      if (target === "check") return { source: "builtin:check", revision: "check", options, plugin: checkPlugin }
      if (!isLocal(target)) return failed("npm plugins are not supported yet")
      const file = yield* entry(target).pipe(Effect.orElseSucceed(() => undefined))
      // A directory plugin's entry may appear, or switch from index.* to server.*.
      if (file !== target) listings.add(target)
      if (file === undefined) {
        yield* Effect.logWarning(`plugin ${target} has no server.* or index.* entry; skipped`)
        return undefined
      }
      const { graph, revision, plugin } = yield* importEntry(file)
      // The entry's own path too: a symlink can be retargeted or removed.
      paths.add(file)
      for (const f of graph.files) paths.add(f)
      for (const d of graph.unresolved) listings.add(d)
      return "error" in plugin ? { ...failed(plugin.error, revision), source: file } : ({ source: file, revision, options, plugin } satisfies Candidate)
    }).pipe(Effect.orElseSucceed((): Candidate | undefined => ({ source: target, revision: "-", options, plugin: { error: "unreadable" } })))

  const readConfig = Effect.gen(function* () {
    const text = yield* fs.readFileString(layout.config).pipe(Effect.option)
    if (Option.isNone(text)) return (lastConfig = { plugins: [] })
    return yield* Effect.try(() => loader.parseJsonc(text.value)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ConfigFile)),
      Effect.tap((config) => Effect.sync(() => (lastConfig = config))),
      Effect.tapError((e) => Effect.logWarning(`${layout.config} ignored, keeping its last valid plugins: ${messageOf(e)}`)),
      Effect.orElseSucceed(() => lastConfig),
    )
  })

  /** The plugins in order (`plugins/` by path, then `vibest.json`), and what to watch for the next change. */
  const read = Effect.gen(function* () {
    const paths = new Set([layout.config, layout.plugins])
    const listings = new Set([layout.plugins])
    const listed = yield* fs.readDirectory(layout.plugins).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
    const discovered: Array<Operation> = []
    for (const name of pluginEntries(listed)) {
      const target = path.join(layout.plugins, name)
      if (!SOURCE.test(name) && !(yield* isDirectory(target))) continue
      discovered.push({ type: "add", target, options: {} })
    }

    const configured: Array<Operation> = []
    for (const raw of (yield* readConfig).plugins ?? []) {
      const { target, options } = typeof raw === "string" ? { target: raw, options: {} } : { target: raw.package, options: raw.options ?? {} }
      if (target.startsWith("-")) {
        configured.push({ type: "remove", target: target.slice(1) })
        continue
      }
      if (!isLocal(target)) {
        configured.push({ type: "add", target, options })
        continue
      }
      const resolved = target.startsWith("file://") ? target.slice("file://".length) : path.resolve(layout.home, target)
      paths.add(resolved)
      // A configured local plugin is a package (a directory, as in OpenCode) or one source file, as in plugins/.
      if (!SOURCE.test(resolved) && !(yield* isDirectory(resolved))) {
        yield* Effect.logWarning(`vibest.json: plugin path must be a directory or a .ts/.js file: ${resolved}`)
        continue
      }
      configured.push({ type: "add", target: resolved, options })
    }

    // Explicit config applies last, so it can remove what the directory listing found.
    const candidates: Array<Candidate> = []
    for (const op of [...discovered, ...configured]) {
      if (op.type === "remove") {
        for (let i = candidates.length - 1; i >= 0; i--) {
          const p = candidates[i]!.plugin
          if ("error" in p ? op.target === "*" : matches(op.target, p.id)) candidates.splice(i, 1)
        }
        continue
      }
      const candidate = yield* load(op.target, op.options, paths, listings)
      if (candidate) candidates.push(candidate)
    }
    // Entries no longer read are forgotten, so the cache stays the size of the plugin list.
    for (const file of imported.keys()) if (!paths.has(file)) imported.delete(file)
    return { candidates, watched: { paths, listings } satisfies Watched }
  })

  return { read }
})

/**
 * Watches the directories that hold what `update` was last given, calling `changed` with each relevant path. A
 * directory is watched once (not recursively) and again when it is replaced; files are matched by name in their
 * parent, so atomic saves (a temp file renamed over), create, delete and rename are all seen. What does not exist yet
 * is watched for in its nearest existing ancestor. `update` says whether the watched set changed: a change made before
 * a watch started is only found by reading again.
 */
export const makeWatcher = (changed: (path: string) => void) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const loader = yield* PluginLoader
    const running = new Map<string, { readonly key: string; readonly close: () => void }>()
    let current: Watched = { paths: new Set(), listings: new Set() }
    const stop = (dir: string) => {
      running.get(dir)?.close()
      running.delete(dir)
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => [...running.keys()].forEach(stop)))

    /** The inode of `dir` when it is a directory. */
    const inode = (dir: string) =>
      fs.stat(dir).pipe(
        Effect.map((info) => (info.type === "Directory" ? String(Option.getOrElse(info.ino, () => 0)) : undefined)),
        Effect.orElseSucceed(() => undefined),
      )

    const update = Effect.fn(function* (watched: Watched) {
      // Keyed by directory: its inode, so a replaced directory is watched again.
      const wanted = new Map<string, string>()
      const paths = new Set<string>()
      // Something that does not exist yet is watched for in its nearest existing ancestor, by the name on its way.
      const watchFor = Effect.fnUntraced(function* (target: string) {
        let name = target
        let key = yield* inode(path.dirname(name))
        while (key === undefined && path.dirname(name) !== name) {
          name = path.dirname(name)
          key = yield* inode(path.dirname(name))
        }
        const dir = path.dirname(name)
        paths.add(name)
        if (key !== undefined) wanted.set(dir, key)
      })
      for (const p of watched.paths) yield* watchFor(p)
      const listings = new Set<string>()
      for (const dir of watched.listings) {
        const key = yield* inode(dir)
        if (key === undefined) {
          yield* watchFor(dir)
          continue
        }
        listings.add(dir)
        wanted.set(dir, key)
      }
      current = { paths, listings }

      let rewatched = false
      for (const [dir, { key }] of running) {
        if (wanted.get(dir) === key) continue
        stop(dir)
        rewatched = true
      }
      for (const [dir, key] of wanted) {
        if (running.has(dir)) continue
        const watching = yield* Effect.try(() =>
          loader.watch(dir, (name) => {
            const file = path.join(dir, name)
            if (current.listings.has(dir) || current.paths.has(file)) changed(file)
          }),
        ).pipe(Effect.tapError((e) => Effect.logWarning(`cannot watch ${dir} for plugin changes: ${messageOf(e)}`)), Effect.option)
        if (Option.isNone(watching)) continue
        running.set(dir, { key, close: watching.value })
        rewatched = true
      }
      return rewatched
    })
    return { update }
  })
