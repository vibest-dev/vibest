// Plugin sources on Bun (plugins.md §4, phase 2): the local import graph of a plugin and loading it afresh, the way
// OpenCode V2's plugin/src/source.bun.ts does it. Reloading drops every file of the graph from Bun's module registry,
// so a changed transitive import is evaluated again, not only the entry.
import fs from "node:fs"
import module from "node:module"
import path from "node:path"
import url from "node:url"

// The module registry, as `require.cache`.
const nativeRequire = module.createRequire(import.meta.url)
const SCANNED = /\.[cm]?[jt]sx?$/
const LOCAL = /^(\.{1,2}\/|\/|file:\/\/)/

/** Where the local `specifier` imported from `dir` leads: the file it resolves to, or the path that is still missing. */
const resolveLocal = (specifier: string, dir: string): { readonly file: string } | { readonly missing: string } => {
  const target = specifier.startsWith("file://") ? url.fileURLToPath(specifier) : specifier
  try {
    return { file: Bun.resolveSync(target, dir) }
  } catch {
    return { missing: path.resolve(dir, target) }
  }
}

const loader = (file: string) =>
  file.endsWith("x") ? (file.endsWith("tsx") ? "tsx" : "jsx") : /\.[cm]?ts$/.test(file) ? "ts" : "js"

/** `entry` and the local files it imports, transitively, outside node_modules; `unresolved`: directories of local imports that do not resolve (yet). */
export const graph = (entry: string) => {
  const files = new Set<string>()
  const unresolved = new Set<string>()
  const visit = (file: string) => {
    if (files.has(file) || (file !== entry && file.split(path.sep).includes("node_modules"))) return
    files.add(file)
    if (!SCANNED.test(file)) return
    let imports: ReadonlyArray<{ readonly path: string }> = []
    try {
      imports = new Bun.Transpiler({ loader: loader(file), target: "bun" }).scan(fs.readFileSync(file, "utf8")).imports
    } catch {
      return // Unreadable or not parseable: loading reports it.
    }
    for (const item of imports) {
      if (!LOCAL.test(item.path)) continue
      const resolved = resolveLocal(item.path, path.dirname(file))
      if ("file" in resolved) visit(resolved.file)
      else unresolved.add(path.dirname(resolved.missing))
    }
  }
  visit(entry)
  return { files: [...files], unresolved: [...unresolved] }
}

// Each load imports its entry and local imports under keys of their own (`<file>?vibest-load=<n>`): since Bun 1.4.3 a
// module whose top-level await never settled stays in the registry under its path, outside `require.cache`, and every
// later import of that path waits for it. node_modules keeps its plain keys, so it is shared and never reloaded.
// Bun hands onResolve the importer without its query, so each file remembers the load that last imported it: a later
// `import("./lazy.ts")` from a running plugin gets that plugin's key, whatever has loaded since.
const LOAD = /\?vibest-load=\d+$/
let loads = 0
const loadOf = new Map<string, number>()

/** Part of the runtime's `Bun.plugin` setup (`plugins.prepare`): give a loaded file's local imports its load's key. */
export const keyLocalImports = (build: Bun.PluginBuilder) =>
  build.onResolve({ filter: LOCAL }, (args) => {
    const n = loadOf.get(args.importer)
    if (n === undefined) return undefined
    // Unresolved: Bun resolves it again and reports it.
    const resolved = resolveLocal(args.path, path.dirname(args.importer))
    if (!("file" in resolved)) return undefined
    return {
      path: resolved.file.split(path.sep).includes("node_modules")
        ? resolved.file
        : `${resolved.file}?vibest-load=${n}`,
    }
  })

/**
 * Evaluate `entry` afresh, top-level await included: import it and its local imports under new keys, after dropping
 * `files` (its previous and current graph) from the module registry so old revisions do not pile up.
 */
export const load = (entry: string, files: ReadonlyArray<string>): Promise<unknown> => {
  const loading = new Set(
    files.flatMap((file) => {
      try {
        return [file, fs.realpathSync(file)]
      } catch {
        return [file]
      }
    }),
  )
  for (const key of Object.keys(nativeRequire.cache))
    if (loading.has(key.replace(LOAD, ""))) delete nativeRequire.cache[key]
  const n = ++loads
  for (const file of loading) loadOf.set(file, n)
  return import(`${entry}?vibest-load=${n}`)
}

/** Watch `directory` (not recursively), calling `changed` with each changed entry's name; registered before it returns. */
export const watch = (directory: string, changed: (name: string) => void) => {
  const watcher = fs.watch(directory, { persistent: false }, (_event, name) => {
    if (name) changed(name)
  })
  // A watched directory that goes away errors on some platforms; the next read re-watches what still exists.
  watcher.on("error", () => watcher.close())
  return () => watcher.close()
}
