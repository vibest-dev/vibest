import { Layout } from "@vibest/schema/layout"
import { ProjectCloneFailed } from "@vibest/schema/project"
import { Config, Effect, FileSystem, Option, Path, Predicate } from "effect"

import { safeRepositoryDirectory } from "../paths.ts"
import { PluginLoader } from "../plugin/sources.ts"
import { remoteRepositoryName } from "../worktree.ts"

export const DEFAULT_CLONE_DIRECTORY = "~/code"

const refused = (message: string) => new ProjectCloneFailed({ message })

const configuredBase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const layout = yield* Layout
  const loader = yield* PluginLoader
  const text = yield* fs.readFileString(layout.config).pipe(Effect.option)

  if (Option.isNone(text)) return DEFAULT_CLONE_DIRECTORY

  const raw = yield* Effect.try({
    try: () => loader.parseJsonc(text.value),
    catch: () => refused(`${layout.config} is not valid JSON`),
  })

  const configured = Predicate.isObject(raw) && "cloneDirectory" in raw ? raw.cloneDirectory : undefined

  if (configured === undefined) return DEFAULT_CLONE_DIRECTORY

  if (!Predicate.isString(configured)) return yield* refused(`${layout.config}: cloneDirectory is not a string`)

  return configured
})

export const cloneDestination = Effect.fn("Project.cloneDestination")(function* (
  url: string,
  directory: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* Config.String("HOME").pipe(Config.withDefault(""), Effect.orDie)
  const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p)
  const base = expand(yield* configuredBase)

  if (!path.isAbsolute(base))
    return yield* refused(
      `the clone directory ${base} is neither absolute nor under ~/; set cloneDirectory in vibest.json`,
    )
  const name = remoteRepositoryName(url)

  if (directory === undefined && !safeRepositoryDirectory(name))
    return yield* refused(`${url} names no repository folder; give --dir`)
  const dest = directory === undefined ? path.join(base, name) : path.resolve(base, expand(directory))

  const left = yield* fs.readDirectory(dest).pipe(
    Effect.map((names) => names.length),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(0)),
    Effect.mapError(() => refused(`${dest} exists and is not an empty directory`)),
  )

  if (left > 0) return yield* refused(`${dest} is not empty`)
  yield* fs
    .makeDirectory(path.dirname(dest), { recursive: true })
    .pipe(Effect.mapError((e) => refused(`cannot make ${path.dirname(dest)}: ${e.message}`)))

  return { dest, base }
})
