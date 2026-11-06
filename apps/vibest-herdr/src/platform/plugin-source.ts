import fs from "node:fs"
import module from "node:module"
import path from "node:path"
import url from "node:url"

const nativeRequire = module.createRequire(import.meta.url)
const SCANNED = /\.[cm]?[jt]sx?$/
const LOCAL = /^(\.{1,2}\/|\/|file:\/\/)/

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
      return
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

const LOAD = /\?vibest-load=\d+$/
let loads = 0
const loadOf = new Map<string, number>()

export const keyLocalImports = (build: Bun.PluginBuilder) =>
  build.onResolve({ filter: LOCAL }, (args) => {
    const n = loadOf.get(args.importer)
    if (n === undefined) return undefined
    const resolved = resolveLocal(args.path, path.dirname(args.importer))
    if (!("file" in resolved)) return undefined
    return {
      path: resolved.file.split(path.sep).includes("node_modules")
        ? resolved.file
        : `${resolved.file}?vibest-load=${n}`,
    }
  })

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

export const watch = (directory: string, changed: (name: string) => void) => {
  const watcher = fs.watch(directory, { persistent: false }, (_event, name) => {
    if (name) changed(name)
  })
  watcher.on("error", () => watcher.close())
  return () => watcher.close()
}
