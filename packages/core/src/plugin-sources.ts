import type * as VibestPlugin from "@vibest/plugin"
import { Context, Crypto, Duration, Effect, FileSystem, Latch, Option, Path, Schema } from "effect"
import { Hex } from "effect/encoding"

import { LayerNode } from "./effect/layer-node.ts"
import { Layout } from "./paths.ts"

export class PluginLoader extends Context.Service<
  PluginLoader,
  {
    readonly prepare: Effect.Effect<void>
    readonly parseJsonc: (text: string) => unknown
    readonly graph: (entry: string) => {
      readonly files: ReadonlyArray<string>
      readonly unresolved: ReadonlyArray<string>
    }
    readonly load: (entry: string, files: ReadonlyArray<string>) => Promise<unknown>
    readonly watch: (directory: string, changed: (name: string) => void) => () => void
  }
>()("vibest/PluginLoader") {
  static readonly node = LayerNode.unbound(PluginLoader)
}

export interface Candidate {
  readonly source: string
  readonly revision: string
  readonly options: Readonly<Record<string, unknown>>
  readonly plugin: VibestPlugin.Plugin.Plugin | { readonly error: string }
}

export interface Watched {
  readonly paths: ReadonlySet<string>
  readonly listings: ReadonlySet<string>
}

interface Collected {
  readonly paths: Set<string>
  readonly listings: Set<string>
}

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

const ConfigEntry = Schema.Union([
  Schema.String,
  Schema.Struct({ package: Schema.String, options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
])
const ConfigFile = Schema.Struct({ plugins: Schema.optional(Schema.Array(ConfigEntry)) })
type ConfigFile = typeof ConfigFile.Type
const PackageManifest = Schema.fromJsonString(Schema.Struct({ name: Schema.String, exports: Schema.Unknown }))
const isPlugin = (u: unknown): u is VibestPlugin.Plugin.Plugin =>
  typeof u === "object" &&
  u !== null &&
  typeof (u as { readonly id?: unknown }).id === "string" &&
  (typeof (u as { readonly effect?: unknown }).effect === "function" ||
    typeof (u as { readonly setup?: unknown }).setup === "function")

const PluginModule = Schema.Struct({
  default: Schema.declare(isPlugin),
})

const EXPORT_CONDITIONS = new Set(["bun", "import", "default"])
const exportTarget = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null) return undefined
  for (const [condition, target] of Object.entries(value)) {
    const found = EXPORT_CONDITIONS.has(condition) ? exportTarget(target) : undefined
    if (found !== undefined) return found
  }
  return undefined
}
const exportedEntries = (exports: unknown) =>
  (typeof exports === "object" && exports !== null && Object.keys(exports).some((key) => key.startsWith("."))
    ? [
        exportTarget((exports as Record<string, unknown>)["./server"]),
        exportTarget((exports as Record<string, unknown>)["."]),
      ]
    : [exportTarget(exports)]
  ).filter((entry) => entry !== undefined)
const CONVENTIONAL_ENTRIES = ["server", "index"].flatMap((name) =>
  [".ts", ".js", ".mts", ".mjs"].map((ext) => name + ext),
)

export type Operation =
  | { readonly type: "add"; readonly target: string; readonly options: Readonly<Record<string, unknown>> }
  | { readonly type: "remove"; readonly target: string }

const SOURCE = /\.[cm]?[jt]s$/
const isLocal = (target: string) =>
  target.startsWith("/") || target.startsWith("./") || target.startsWith("../") || target.startsWith("file://")

export const pluginEntries = (names: ReadonlyArray<string>) =>
  names.filter((n) => n !== "node_modules" && !n.startsWith(".") && !n.endsWith(".d.ts")).sort()

type Graph = ReturnType<PluginLoader["Service"]["graph"]>
type Imported = {
  readonly real: string
  readonly graph: Graph
  readonly revision: string
  readonly plugin: Candidate["plugin"]
}

export const makeSources = Effect.fnUntraced(function* (
  timeout: Duration.Input,
  options?: { readonly quiet?: boolean },
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const layout = yield* Layout
  const loader = yield* PluginLoader
  const imported = new Map<string, Imported>()
  let lastConfig: ConfigFile = { plugins: [] }
  let warnedConfiguredRuntime = false
  const quiet = options?.quiet === true
  const warn = (message: string) => (quiet ? Effect.void : Effect.logWarning(message))

  const sha = (bytes: Uint8Array) => crypto.digest("SHA-256", bytes).pipe(Effect.map(Hex.encode))
  const utf8 = (s: string) => new TextEncoder().encode(s)
  const isDirectory = (target: string) =>
    fs.stat(target).pipe(
      Effect.map((i) => i.type === "Directory"),
      Effect.orElseSucceed(() => false),
    )
  const revisionOf = (graph: Graph) =>
    Effect.forEach(
      [...graph.files.map((f) => [f, false] as const), ...graph.unresolved.map((d) => [d, true] as const)],
      ([target, listing]) =>
        (listing
          ? fs.readDirectory(target).pipe(Effect.flatMap((names) => sha(utf8([...names].sort().join("\n")))))
          : fs.readFile(target).pipe(Effect.flatMap(sha))
        ).pipe(
          Effect.orElseSucceed(() => "missing"),
          Effect.map((digest) => `${target}\0${digest}`),
        ),
    ).pipe(
      Effect.flatMap((lines) => sha(utf8(lines.join("\n")))),
      Effect.map((hex) => hex.slice(0, 12)),
    )

  const entryCandidates = (target: string) =>
    fs.readFileString(path.join(target, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PackageManifest)),
      Effect.map(({ exports }) => exportedEntries(exports)),
      Effect.orElseSucceed(() => CONVENTIONAL_ENTRIES),
      Effect.map((entries) => entries.map((entry) => path.resolve(target, entry))),
    )

  const entry = Effect.fn(function* (target: string, paths: Set<string>) {
    if (!(yield* isDirectory(target))) return target
    const candidates = yield* entryCandidates(target)
    for (const file of candidates) paths.add(file)
    for (const file of candidates) if (yield* fs.exists(file)) return file
    return undefined
  })

  const canonical = (file: string) =>
    fs.realPath(file).pipe(
      Effect.catch(() => fs.readLink(file).pipe(Effect.map((target) => path.resolve(path.dirname(file), target)))),
      Effect.orElseSucceed(() => file),
    )

  const importEntry = Effect.fn(function* (file: string) {
    const previous = imported.get(file)
    const real = yield* canonical(file)
    if (previous !== undefined && previous.real === real && (yield* revisionOf(previous.graph)) === previous.revision)
      return previous
    const graph = yield* Effect.try(() => loader.graph(real)).pipe(
      Effect.orElseSucceed((): Graph => ({ files: [real], unresolved: [] })),
    )
    const revision = yield* revisionOf(graph)
    const forget = [...new Set([...graph.files, ...(previous?.graph.files ?? [])])]
    const module = yield* Effect.tryPromise({
      try: () => loader.load(real, forget),
      catch: (e) => `import failed: ${messageOf(e)}`,
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(`import timed out after ${Duration.format(Duration.fromInputUnsafe(timeout))}`),
      }),
      Effect.flatMap((m) =>
        Schema.decodeUnknownEffect(PluginModule)(m).pipe(
          Effect.mapError(() => "must export default Plugin.define({ id, effect }) or Plugin.define({ id, setup })"),
        ),
      ),
      Effect.result,
    )
    const result: Imported = {
      real,
      graph,
      revision,
      plugin: module._tag === "Failure" ? { error: module.failure } : module.success.default,
    }
    imported.set(file, result)
    return result
  })

  const load = ({ target, options }: Extract<Operation, { readonly type: "add" }>, { paths, listings }: Collected) =>
    Effect.gen(function* () {
      const failed = (error: string, revision = "-"): Candidate => ({
        source: target,
        revision,
        options,
        plugin: { error },
      })
      if (!isLocal(target)) return failed("npm plugins are not supported yet")
      const file = yield* entry(target, paths).pipe(Effect.orElseSucceed(() => undefined))
      if (file !== target) listings.add(target)
      if (file === undefined) {
        yield* warn(`plugin ${target} has no package.json exports, server.* or index.* entry; skipped`)
        return undefined
      }
      const { graph, revision, plugin } = yield* importEntry(file)
      paths.add(file)
      for (const f of graph.files) paths.add(f)
      for (const d of graph.unresolved) listings.add(d)
      return "error" in plugin
        ? { ...failed(plugin.error, revision), source: file }
        : ({ source: file, revision, options, plugin } satisfies Candidate)
    }).pipe(
      Effect.orElseSucceed((): Candidate | undefined => ({
        source: target,
        revision: "-",
        options,
        plugin: { error: "unreadable" },
      })),
    )

  const readConfig = Effect.gen(function* () {
    const text = yield* fs.readFileString(layout.config).pipe(Effect.option)
    if (Option.isNone(text)) return (lastConfig = { plugins: [] })
    return yield* Effect.try(() => loader.parseJsonc(text.value)).pipe(
      Effect.tap((raw) =>
        Effect.gen(function* () {
          const configured =
            raw !== null &&
            typeof raw === "object" &&
            "runtime" in raw &&
            (raw as { readonly runtime?: unknown }).runtime !== undefined
          if (!configured || warnedConfiguredRuntime) return
          warnedConfiguredRuntime = true
          yield* warn(`${layout.config}: "runtime" is ignored; run vibest in the runtime's terminal, or pass --runtime`)
        }),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(ConfigFile)),
      Effect.tap((config) => Effect.sync(() => (lastConfig = config))),
      Effect.tapError((e) => warn(`${layout.config} ignored, keeping its last valid plugins: ${messageOf(e)}`)),
      Effect.orElseSucceed(() => lastConfig),
    )
  })

  const operations = Effect.gen(function* () {
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
      const { target, options } =
        typeof raw === "string" ? { target: raw, options: {} } : { target: raw.package, options: raw.options ?? {} }
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
      if (!SOURCE.test(resolved) && !(yield* isDirectory(resolved))) {
        yield* warn(`vibest.json: plugin path must be a directory or a .ts/.js file: ${resolved}`)
        continue
      }
      configured.push({ type: "add", target: resolved, options })
    }

    return {
      operations: [...discovered, ...configured],
      watched: { paths, listings } satisfies Collected,
    }
  })

  const retain = (paths: ReadonlySet<string>) =>
    Effect.sync(() => {
      for (const file of imported.keys()) if (!paths.has(file)) imported.delete(file)
    })

  return { operations, load, retain }
})

export const WATCH_PROBE = ".plugins-watch"

export const makeWatcher = (changed: (path: string) => void, retry: Duration.Input) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const loader = yield* PluginLoader
    const probe = path.join((yield* Layout).home, WATCH_PROBE)
    const probeSeen = Latch.makeUnsafe(false)
    const running = new Map<string, { readonly key: string; readonly close: () => void }>()
    let current: Watched = { paths: new Set(), listings: new Set() }
    const stop = (dir: string) => {
      running.get(dir)?.close()
      running.delete(dir)
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => [...running.keys()].forEach(stop)))

    const inode = (dir: string) =>
      fs.stat(dir).pipe(
        Effect.map((info) => (info.type === "Directory" ? String(Option.getOrElse(info.ino, () => 0)) : undefined)),
        Effect.orElseSucceed(() => undefined),
      )

    const update = Effect.fn(function* (watched: Watched) {
      const wanted = new Map<string, string>()
      const paths = new Set<string>()
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
            if (file === probe) probeSeen.openUnsafe()
            else if (current.listings.has(dir) || current.paths.has(file)) changed(file)
          }),
        ).pipe(
          Effect.tapError((e) => Effect.logWarning(`cannot watch ${dir} for plugin changes: ${messageOf(e)}`)),
          Effect.option,
        )
        if (Option.isNone(watching)) continue
        running.set(dir, { key, close: watching.value })
        rewatched = true
      }
      return rewatched
    })

    const live = Effect.gen(function* () {
      for (let attempt = 1; ; attempt++) {
        probeSeen.closeUnsafe()
        yield* fs
          .writeFileString(probe, `${attempt}\n`)
          .pipe(
            Effect.catch((e) => Effect.logWarning(`cannot write ${probe} to check the plugin watch: ${messageOf(e)}`)),
          )
        if (Option.isSome(yield* probeSeen.await.pipe(Effect.timeoutOption(retry)))) return
      }
    })
    return { update, live }
  })
