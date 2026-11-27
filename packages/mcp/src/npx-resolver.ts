import { PrivateFile } from "@vibest/core/effect/private-file"
import { Clock, Duration, Effect, FileSystem, Match, Option, Path, Predicate, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export * as NpxResolver from "./npx-resolver.ts"

const CACHE_VERSION = 2
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FORCE_CACHE_TIMEOUT = Duration.seconds(30)
const NPM_CONFIG_TIMEOUT = Duration.seconds(5)
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

const detectJsBinary = (fs: FileSystem.FileSystem, path: Path.Path, binPath: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const ext = path.extname(binPath).toLowerCase()

    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return true

    const content = yield* fs.readFileString(binPath).pipe(Effect.orElseSucceed(() => ""))
    const firstLine = content.slice(0, 256).split("\n")[0] ?? ""

    return firstLine.startsWith("#!") && firstLine.includes("node")
  })

const findNodeModulesDir = (path: Path.Path, packageDir: string): string => {
  const parts = packageDir.split(path.sep)
  const idx = parts.lastIndexOf("node_modules")

  return idx >= 0 ? parts.slice(0, idx + 1).join(path.sep) : path.join(packageDir, "..")
}

const readPackageJson = (
  fs: FileSystem.FileSystem,
  packageJsonPath: string,
): Effect.Effect<Option.Option<typeof PackageJsonSchema.Type>> =>
  fs.readFileString(packageJsonPath).pipe(
    Effect.map((raw) => {
      try {
        return decodePackageJson(JSON.parse(raw))
      } catch {
        return Option.none()
      }
    }),
    Effect.orElseSucceed(() => Option.none()),
  )

const findCachedPackageDir = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cacheDir: string,
  packageName: string,
  exactVersion?: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const npxDir = path.join(cacheDir, "_npx")
    const entries = yield* fs.readDirectory(npxDir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))

    if (entries.length === 0) return undefined
    const packagePathParts = packageName.startsWith("@") ? packageName.split("/") : [packageName]

    const withMtime: Array<{ readonly name: string; readonly mtime: number }> = []

    for (const name of entries) {
      const info = yield* fs.stat(path.join(npxDir, name)).pipe(Effect.orElseSucceed(() => undefined))

      if (info?.type !== "Directory") continue
      const mtime = Option.isSome(info.mtime) ? info.mtime.value.getTime() : 0
      withMtime.push({ name, mtime })
    }

    for (const entry of withMtime.toSorted((a, b) => b.mtime - a.mtime)) {
      const pkgDir = path.join(npxDir, entry.name, "node_modules", ...packagePathParts)
      const packageJsonPath = path.join(pkgDir, "package.json")
      const exists = yield* fs.exists(packageJsonPath).pipe(Effect.orElseSucceed(() => false))

      if (!exists) continue

      if (exactVersion !== undefined) {
        const parsed = yield* readPackageJson(fs, packageJsonPath)

        if (Option.isNone(parsed) || parsed.value.version !== exactVersion) continue
      }

      return pkgDir
    }

    return undefined
  })

const resolveFromNpmCache = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cacheDir: string,
  packageSpec: string,
  now: number,
  binName?: string,
): Effect.Effect<NpxCacheEntry | undefined> =>
  Effect.gen(function* () {
    const parsedSpec = parsePackageSpec(packageSpec)

    if (!parsedSpec) return undefined
    const packageDir = yield* findCachedPackageDir(fs, path, cacheDir, parsedSpec.packageName, parsedSpec.exactVersion)

    if (!packageDir) return undefined
    const parsedPkg = yield* readPackageJson(fs, path.join(packageDir, "package.json"))

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
    const nodeModulesDir = findNodeModulesDir(path, packageDir)
    const binLink = chosenBinName ? path.join(nodeModulesDir, ".bin", chosenBinName) : undefined

    const linkExists = binLink !== undefined ? yield* fs.exists(binLink).pipe(Effect.orElseSucceed(() => false)) : false

    let resolvedBin =
      linkExists && binLink !== undefined ? yield* fs.realPath(binLink).pipe(Effect.orElseSucceed(() => "")) : ""

    if (!resolvedBin) {
      resolvedBin = path.resolve(packageDir, binRel)
      const binExists = yield* fs.exists(resolvedBin).pipe(Effect.orElseSucceed(() => false))

      if (!binExists) return undefined
    }

    const isJs = yield* detectJsBinary(fs, path, resolvedBin)

    return {
      resolvedBin,
      resolvedAt: now,
      ...(pkg.version !== undefined && { packageVersion: pkg.version }),
      isJs,
    }
  })

const detectNpmCacheDir = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"] | undefined,
  override?: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    if (override) return override

    if (process.env.NPM_CONFIG_CACHE) return process.env.NPM_CONFIG_CACHE

    if (!spawner) return undefined

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("npm", ["config", "get", "cache"], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
          }),
        )

        const chunks: Array<string> = []

        yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              chunks.push(chunk)
            }),
          ),
        )

        const code = yield* handle.exitCode

        if (Number(code) !== 0) return undefined
        const trimmed = chunks.join("").trim()

        return trimmed.length > 0 ? trimmed : undefined
      }),
    ).pipe(
      Effect.timeoutOption(NPM_CONFIG_TIMEOUT),
      Effect.map((opt) => Option.getOrUndefined(opt)),
      Effect.orElseSucceed(() => undefined),
    )
  })

const cacheFilePath = (path: Path.Path, vibestHome: string): string =>
  path.join(vibestHome, "cache", "npx-bin-cache.json")

const loadCache = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  vibestHome: string,
): Effect.Effect<NpxCache | undefined> =>
  fs.readFileString(cacheFilePath(path, vibestHome)).pipe(
    Effect.map((raw) => {
      try {
        const decoded = decodeNpxCache(JSON.parse(raw))

        return Option.isSome(decoded) ? decoded.value : undefined
      } catch {
        return undefined
      }
    }),
    Effect.orElseSucceed(() => undefined),
  )

const saveCacheEntry = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  vibestHome: string,
  key: string,
  entry: NpxCacheEntry,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const file = cacheFilePath(path, vibestHome)
    const existing = yield* loadCache(fs, path, vibestHome)
    const entries = { ...existing?.entries, [key]: entry }
    yield* PrivateFile.writeAtomic(fs, path, file, JSON.stringify({ version: CACHE_VERSION, entries }, null, 2))
  }).pipe(Effect.ignore)

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
): Effect.fn.Return<NpxResolution | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const parsed = Match.value(options.command).pipe(
    Match.when("npx", () => parseNpxArgs(options.args)),
    Match.when("npm", () => parseNpmExecArgs(options.args)),
    Match.orElse(() => undefined),
  )

  if (!parsed) return undefined
  const packageSpec = parsePackageSpec(parsed.packageSpec)
  const cacheKey = JSON.stringify([options.command, parsed.packageSpec, parsed.binName ?? ""])
  const now = yield* Clock.currentTimeMillis
  const cache = yield* loadCache(fs, path, options.vibestHome)
  const cached = cache?.entries[cacheKey]

  if (
    cached &&
    now - cached.resolvedAt < CACHE_TTL_MS &&
    (!packageSpec?.exactVersion || cached.packageVersion === packageSpec.exactVersion) &&
    (yield* fs.exists(cached.resolvedBin).pipe(Effect.orElseSucceed(() => false)))
  ) {
    return { binPath: cached.resolvedBin, extraArgs: parsed.extraArgs, isJs: cached.isJs }
  }

  const npmCacheDir = yield* detectNpmCacheDir(options.spawner, options.npmCacheDir)

  if (!npmCacheDir) return undefined
  const resolved = yield* resolveFromNpmCache(fs, path, npmCacheDir, parsed.packageSpec, now, parsed.binName)

  if (resolved) {
    yield* saveCacheEntry(fs, path, options.vibestHome, cacheKey, resolved)

    return { binPath: resolved.resolvedBin, extraArgs: parsed.extraArgs, isJs: resolved.isJs }
  }

  if (options.populateOnMiss === false) return undefined
  yield* populateNpmCache(parsed.packageSpec, options.spawner)

  const afterInstall = yield* resolveFromNpmCache(fs, path, npmCacheDir, parsed.packageSpec, now, parsed.binName)

  if (!afterInstall) return undefined
  yield* saveCacheEntry(fs, path, options.vibestHome, cacheKey, afterInstall)

  return { binPath: afterInstall.resolvedBin, extraArgs: parsed.extraArgs, isJs: afterInstall.isJs }
})

export const rewriteCommand = Effect.fn("NpxResolver.rewriteCommand")(function* (
  options: ResolveOptions,
): Effect.fn.Return<
  {
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly resolved: boolean
  },
  never,
  FileSystem.FileSystem | Path.Path
> {
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
