import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { Clock, Duration, Effect, Match, Option, Predicate, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { writeAtomicFile } from "./fs-util.ts"

export * as NpxResolver from "./npx-resolver.ts"

const CACHE_VERSION = 2
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FORCE_CACHE_TIMEOUT = Duration.seconds(30)
const EXACT_PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/

const NpxCacheEntrySchema = Schema.Struct({
  resolvedBin: Schema.String,
  resolvedAt: Schema.Number,
  packageVersion: Schema.optional(Schema.String),
  isJs: Schema.Boolean,
})

type NpxCacheEntry = typeof NpxCacheEntrySchema.Type

const NpxCacheSchema = Schema.Struct({
  version: Schema.Literal(CACHE_VERSION),
  entries: Schema.Record(Schema.String, NpxCacheEntrySchema),
})

type NpxCache = typeof NpxCacheSchema.Type

const PackageJsonSchema = Schema.Struct({
  bin: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
  version: Schema.optional(Schema.String),
})

const decodeNpxCache = Schema.decodeUnknownOption(NpxCacheSchema)
const decodePackageJson = Schema.decodeUnknownOption(PackageJsonSchema)

export interface NpxResolution {
  readonly binPath: string
  readonly extraArgs: ReadonlyArray<string>
  readonly isJs: boolean
}

export interface ResolveOptions {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly vibestHome: string
  readonly npmCacheDir?: string | undefined
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"] | undefined
  readonly populateOnMiss?: boolean | undefined
}

interface ParsedInvocation {
  readonly packageSpec: string
  readonly binName?: string
  readonly extraArgs: ReadonlyArray<string>
}

interface ParsedPackageSpec {
  readonly packageName: string
  readonly exactVersion?: string
}

export const parseNpxArgs = (args: ReadonlyArray<string>): ParsedInvocation | undefined => {
  const separatorIndex = args.indexOf("--")
  const before = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args
  const after = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : []
  const positionals: Array<string> = []
  let packageSpec: string | undefined
  let sawPackageFlag = false
  let foundFirstPositional = false

  for (let i = 0; i < before.length; i++) {
    const arg = before[i]

    if (arg === undefined) return undefined

    if (foundFirstPositional) {
      positionals.push(arg)
      continue
    }

    if (arg === "-y" || arg === "--yes") continue

    if (arg === "-p" || arg === "--package") {
      const value = before[i + 1]

      if (!value || value.startsWith("-")) return undefined

      if (!packageSpec) packageSpec = value
      sawPackageFlag = true
      i++
      continue
    }

    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length)

      if (!value) return undefined

      if (!packageSpec) packageSpec = value
      sawPackageFlag = true
      continue
    }

    if (arg.startsWith("-")) return undefined
    positionals.push(arg)
    foundFirstPositional = true
  }

  const separatedAfter = separatorIndex >= 0 && after.length > 0 ? ["--", ...after] : after

  if (sawPackageFlag) {
    const binName = positionals[0]

    if (!packageSpec || !binName) return undefined

    return { packageSpec, binName, extraArgs: positionals.slice(1).concat(separatedAfter) }
  }

  const packagePositional = positionals[0]

  if (!packagePositional) return undefined

  return { packageSpec: packagePositional, extraArgs: positionals.slice(1).concat(separatedAfter) }
}

export const parseNpmExecArgs = (args: ReadonlyArray<string>): ParsedInvocation | undefined => {
  if (args[0] !== "exec") return undefined
  const execArgs = args.slice(1)
  const separatorIndex = execArgs.indexOf("--")

  if (separatorIndex < 0) return undefined
  const before = execArgs.slice(0, separatorIndex)
  const after = execArgs.slice(separatorIndex + 1)
  let packageSpec: string | undefined

  for (let i = 0; i < before.length; i++) {
    const arg = before[i]

    if (arg === undefined) return undefined

    if (arg === "-y" || arg === "--yes") continue

    if (arg === "--package") {
      const value = before[i + 1]

      if (!value || value.startsWith("-")) return undefined

      if (!packageSpec) packageSpec = value
      i++
      continue
    }

    if (arg.startsWith("--package=")) {
      const value = arg.slice("--package=".length)

      if (!value) return undefined

      if (!packageSpec) packageSpec = value
      continue
    }

    if (arg.startsWith("-")) return undefined
  }

  const binName = after[0]

  if (!packageSpec || !binName) return undefined

  return { packageSpec, binName, extraArgs: after.slice(1) }
}

export const parsePackageSpec = (spec: string): ParsedPackageSpec | undefined => {
  const trimmed = spec.trim()

  if (!trimmed) return undefined
  let packageName: string
  let requestedVersion: string | undefined

  if (trimmed.startsWith("@")) {
    const slashIndex = trimmed.indexOf("/")

    if (slashIndex < 0) return undefined
    const atIndex = trimmed.lastIndexOf("@")

    if (atIndex > slashIndex) {
      packageName = trimmed.slice(0, atIndex)
      requestedVersion = trimmed.slice(atIndex + 1)
    } else {
      packageName = trimmed
    }
  } else {
    const atIndex = trimmed.indexOf("@")

    if (atIndex >= 0) {
      packageName = trimmed.slice(0, atIndex)
      requestedVersion = trimmed.slice(atIndex + 1)
    } else {
      packageName = trimmed
    }
  }

  if (!packageName) return undefined
  const normalizedVersion = requestedVersion?.replace(/^=/, "").replace(/^v/i, "")

  const exactVersion =
    normalizedVersion !== undefined && EXACT_PACKAGE_VERSION_RE.test(normalizedVersion) ? normalizedVersion : undefined

  return { packageName, ...(exactVersion !== undefined && { exactVersion }) }
}

const defaultBinName = (packageName: string): string => {
  if (packageName.startsWith("@")) {
    const parts = packageName.split("/")

    return parts[1] ?? packageName.replace("@", "").replace("/", "-")
  }

  return packageName
}

const buildBinCandidates = (packageName: string, explicitBin?: string): ReadonlyArray<string> => {
  const candidates: Array<string> = []

  if (explicitBin) candidates.push(explicitBin)

  if (packageName.startsWith("@")) {
    const parts = packageName.split("/")
    const namePart = parts[1] ?? ""
    const scopePart = parts[0]?.replace("@", "") ?? ""

    if (namePart) candidates.push(namePart)

    if (scopePart && namePart) candidates.push(`${scopePart}-${namePart}`)
  } else {
    candidates.push(packageName)
  }

  return [...new Set(candidates.filter((c) => c.length > 0))]
}

const safeStatMtime = (target: string): number => {
  try {
    return fs.statSync(target).mtimeMs
  } catch {
    return 0
  }
}

const safeRealpath = (target: string): string => {
  try {
    return fs.realpathSync(target)
  } catch {
    return ""
  }
}

const detectJsBinary = (binPath: string): boolean => {
  const ext = path.extname(binPath).toLowerCase()

  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return true

  try {
    const fd = fs.openSync(binPath, "r")

    try {
      const buf = Buffer.alloc(256)
      fs.readSync(fd, buf, 0, 256, 0)
      const firstLine = buf.toString("utf8").split("\n")[0] ?? ""

      return firstLine.startsWith("#!") && firstLine.includes("node")
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

const findNodeModulesDir = (packageDir: string): string => {
  const parts = packageDir.split(path.sep)
  const idx = parts.lastIndexOf("node_modules")

  return idx >= 0 ? parts.slice(0, idx + 1).join(path.sep) : path.join(packageDir, "..")
}

const findCachedPackageDir = (cacheDir: string, packageName: string, exactVersion?: string): string | undefined => {
  const npxDir = path.join(cacheDir, "_npx")

  if (!fs.existsSync(npxDir)) return undefined
  const packagePathParts = packageName.startsWith("@") ? packageName.split("/") : [packageName]

  const candidates = fs
    .readdirSync(npxDir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? [{ name: entry.name, mtime: safeStatMtime(path.join(npxDir, entry.name)) }] : [],
    )
    .toSorted((a, b) => b.mtime - a.mtime)

  for (const entry of candidates) {
    const pkgDir = path.join(npxDir, entry.name, "node_modules", ...packagePathParts)
    const packageJsonPath = path.join(pkgDir, "package.json")

    if (!fs.existsSync(packageJsonPath)) continue

    if (exactVersion !== undefined) {
      try {
        const parsed = decodePackageJson(JSON.parse(fs.readFileSync(packageJsonPath, "utf8")))

        if (Option.isNone(parsed) || parsed.value.version !== exactVersion) continue
      } catch {
        continue
      }
    }

    return pkgDir
  }

  return undefined
}

const resolveFromNpmCache = (
  cacheDir: string,
  packageSpec: string,
  now: number,
  binName?: string,
): NpxCacheEntry | undefined => {
  const parsedSpec = parsePackageSpec(packageSpec)

  if (!parsedSpec) return undefined
  const packageDir = findCachedPackageDir(cacheDir, parsedSpec.packageName, parsedSpec.exactVersion)

  if (!packageDir) return undefined
  const packageJsonPath = path.join(packageDir, "package.json")

  if (!fs.existsSync(packageJsonPath)) return undefined
  let parsedPkg: Option.Option<typeof PackageJsonSchema.Type> = Option.none()

  try {
    parsedPkg = decodePackageJson(JSON.parse(fs.readFileSync(packageJsonPath, "utf8")))
  } catch {
    return undefined
  }

  if (Option.isNone(parsedPkg)) return undefined
  const pkg = parsedPkg.value

  if (pkg.bin === undefined) return undefined
  let chosenBinName: string | undefined
  let binRel: string | undefined

  if (Predicate.isString(pkg.bin)) {
    chosenBinName = defaultBinName(parsedSpec.packageName)
    binRel = pkg.bin
  } else {
    const candidates = buildBinCandidates(parsedSpec.packageName, binName)

    for (const candidate of candidates) {
      const value = pkg.bin[candidate]

      if (value) {
        chosenBinName = candidate
        binRel = value
        break
      }
    }

    if (!binRel) {
      const firstEntry = Object.entries(pkg.bin)[0]

      if (firstEntry) {
        chosenBinName = firstEntry[0]
        binRel = firstEntry[1]
      }
    }
  }

  if (!binRel) return undefined
  const nodeModulesDir = findNodeModulesDir(packageDir)
  const binLink = chosenBinName ? path.join(nodeModulesDir, ".bin", chosenBinName) : undefined
  let resolvedBin = binLink && fs.existsSync(binLink) ? safeRealpath(binLink) : ""

  if (!resolvedBin) {
    resolvedBin = path.resolve(packageDir, binRel)

    if (!fs.existsSync(resolvedBin)) return undefined
  }

  return {
    resolvedBin,
    resolvedAt: now,
    ...(pkg.version !== undefined && { packageVersion: pkg.version }),
    isJs: detectJsBinary(resolvedBin),
  }
}

const detectNpmCacheDir = (override?: string): string | undefined => {
  if (override) return override

  if (process.env.NPM_CONFIG_CACHE) return process.env.NPM_CONFIG_CACHE

  try {
    const result = childProcess.spawnSync("npm", ["config", "get", "cache"], { encoding: "utf8", timeout: 5_000 })

    if (result.status === 0) {
      const trimmed = result.stdout.trim()

      return trimmed.length > 0 ? trimmed : undefined
    }
  } catch {
    return undefined
  }

  return undefined
}

const cacheFilePath = (vibestHome: string): string => path.join(vibestHome, "cache", "npx-bin-cache.json")

const loadCache = (vibestHome: string): NpxCache | undefined => {
  const file = cacheFilePath(vibestHome)

  if (!fs.existsSync(file)) return undefined

  try {
    const decoded = decodeNpxCache(JSON.parse(fs.readFileSync(file, "utf8")))

    return Option.isSome(decoded) ? decoded.value : undefined
  } catch {
    return undefined
  }
}

const saveCacheEntry = (vibestHome: string, key: string, entry: NpxCacheEntry): void => {
  try {
    const file = cacheFilePath(vibestHome)
    const existing = loadCache(vibestHome)
    const entries = { ...existing?.entries, [key]: entry }
    writeAtomicFile(file, JSON.stringify({ version: CACHE_VERSION, entries }, null, 2))
  } catch {
    return
  }
}

const populateNpmCache = (
  packageSpec: string,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"] | undefined,
): Effect.Effect<void> => {
  if (!spawner) return Effect.void

  return Effect.scoped(
    spawner
      .spawn(
        ChildProcess.make("npm", ["exec", "--yes", "--package", packageSpec, "--", "node", "-e", "1"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.flatMap((handle) => handle.exitCode),
        Effect.timeoutOption(FORCE_CACHE_TIMEOUT),
        Effect.asVoid,
        Effect.ignore,
      ),
  )
}

export const resolve = Effect.fn("NpxResolver.resolve")(function* (
  options: ResolveOptions,
): Effect.fn.Return<NpxResolution | undefined> {
  const parsed = Match.value(options.command).pipe(
    Match.when("npx", () => parseNpxArgs(options.args)),
    Match.when("npm", () => parseNpmExecArgs(options.args)),
    Match.orElse(() => undefined),
  )

  if (!parsed) return undefined
  const packageSpec = parsePackageSpec(parsed.packageSpec)
  const cacheKey = JSON.stringify([options.command, parsed.packageSpec, parsed.binName ?? ""])
  const now = yield* Clock.currentTimeMillis
  const cache = yield* Effect.sync(() => loadCache(options.vibestHome))
  const cached = cache?.entries[cacheKey]

  if (
    cached &&
    now - cached.resolvedAt < CACHE_TTL_MS &&
    fs.existsSync(cached.resolvedBin) &&
    (!packageSpec?.exactVersion || cached.packageVersion === packageSpec.exactVersion)
  ) {
    return { binPath: cached.resolvedBin, extraArgs: parsed.extraArgs, isJs: cached.isJs }
  }

  const npmCacheDir = yield* Effect.sync(() => detectNpmCacheDir(options.npmCacheDir))

  if (!npmCacheDir) return undefined
  const resolved = yield* Effect.sync(() => resolveFromNpmCache(npmCacheDir, parsed.packageSpec, now, parsed.binName))

  if (resolved) {
    yield* Effect.sync(() => saveCacheEntry(options.vibestHome, cacheKey, resolved))

    return { binPath: resolved.resolvedBin, extraArgs: parsed.extraArgs, isJs: resolved.isJs }
  }

  if (options.populateOnMiss === false) return undefined
  yield* populateNpmCache(parsed.packageSpec, options.spawner)

  const afterInstall = yield* Effect.sync(() =>
    resolveFromNpmCache(npmCacheDir, parsed.packageSpec, now, parsed.binName),
  )

  if (!afterInstall) return undefined
  yield* Effect.sync(() => saveCacheEntry(options.vibestHome, cacheKey, afterInstall))

  return { binPath: afterInstall.resolvedBin, extraArgs: parsed.extraArgs, isJs: afterInstall.isJs }
})

export const rewriteCommand = Effect.fn("NpxResolver.rewriteCommand")(function* (
  options: ResolveOptions,
): Effect.fn.Return<{
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly resolved: boolean
}> {
  const hit = yield* resolve(options)

  if (!hit) return { command: options.command, args: options.args, resolved: false }

  if (hit.isJs) {
    return {
      command: "node",
      args: [hit.binPath, ...hit.extraArgs],
      resolved: true,
    }
  }

  return {
    command: hit.binPath,
    args: hit.extraArgs,
    resolved: true,
  }
})
