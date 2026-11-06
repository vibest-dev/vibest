import type * as VibestPlugin from "@vibest/plugin"
import { Context, Crypto, Duration, Effect, FileSystem, Option, Path, Schema } from "effect"
import { Hex } from "effect/encoding"

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
>()("vibest/PluginLoader") {}

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

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

const ConfigEntry = Schema.Union([
  Schema.String,
  Schema.Struct({ package: Schema.String, options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
])
const ConfigFile = Schema.Struct({ plugins: Schema.optional(Schema.Array(ConfigEntry)) })
type ConfigFile = typeof ConfigFile.Type
const PluginModule = Schema.Struct({
  default: Schema.Struct({
    id: Schema.String,
    effect: Schema.declare<VibestPlugin.Plugin.Plugin["effect"]>(
      (u): u is VibestPlugin.Plugin.Plugin["effect"] => typeof u === "function",
    ),
  }),
})

type Operation =
  | { readonly type: "add"; readonly target: string; readonly options: Readonly<Record<string, unknown>> }
  | { readonly type: "remove"; readonly target: string }

const SOURCE = /\.[cm]?[jt]s$/
const isLocal = (target: string) =>
  target.startsWith("/") || target.startsWith("./") || target.startsWith("../") || target.startsWith("file://")
const matches = (selector: string, id: string) =>
  selector === "*" || (selector.endsWith(".*") ? id.startsWith(selector.slice(0, -1)) : selector === id)

export const pluginEntries = (names: ReadonlyArray<string>) =>
  names.filter((n) => n !== "node_modules" && !n.startsWith(".") && !n.endsWith(".d.ts")).sort()

type Graph = ReturnType<PluginLoader["Service"]["graph"]>
type Imported = {
  readonly real: string
  readonly graph: Graph
  readonly revision: string
  readonly plugin: Candidate["plugin"]
}

export const makeSources = Effect.fnUntraced(function* (timeout: Duration.Input) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const layout = yield* Layout
  const loader = yield* PluginLoader
  const imported = new Map<string, Imported>()
  let lastConfig: ConfigFile = { plugins: [] }

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

  const entry = Effect.fn(function* (target: string) {
    if (!(yield* isDirectory(target))) return target
    for (const name of ["server", "index"]) {
      for (const ext of [".ts", ".js", ".mts", ".mjs"]) {
        const file = path.join(target, name + ext)
        if (yield* fs.exists(file)) return file
      }
    }
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
          Effect.mapError(() => "must export default Plugin.define({ id, effect })"),
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

  const load = (
    target: string,
    options: Readonly<Record<string, unknown>>,
    paths: Set<string>,
    listings: Set<string>,
  ) =>
    Effect.gen(function* () {
      const failed = (error: string, revision = "-"): Candidate => ({
        source: target,
        revision,
        options,
        plugin: { error },
      })
      if (!isLocal(target)) return failed("npm plugins are not supported yet")
      const file = yield* entry(target).pipe(Effect.orElseSucceed(() => undefined))
      if (file !== target) listings.add(target)
      if (file === undefined) {
        yield* Effect.logWarning(`plugin ${target} has no server.* or index.* entry; skipped`)
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
      Effect.flatMap(Schema.decodeUnknownEffect(ConfigFile)),
      Effect.tap((config) => Effect.sync(() => (lastConfig = config))),
      Effect.tapError((e) =>
        Effect.logWarning(`${layout.config} ignored, keeping its last valid plugins: ${messageOf(e)}`),
      ),
      Effect.orElseSucceed(() => lastConfig),
    )
  })

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
        yield* Effect.logWarning(`vibest.json: plugin path must be a directory or a .ts/.js file: ${resolved}`)
        continue
      }
      configured.push({ type: "add", target: resolved, options })
    }

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
    for (const file of imported.keys()) if (!paths.has(file)) imported.delete(file)
    return { candidates, watched: { paths, listings } satisfies Watched }
  })

  return { read }
})

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
            if (current.listings.has(dir) || current.paths.has(file)) changed(file)
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
    return { update }
  })
