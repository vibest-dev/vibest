import { ID } from "@vibest/schema/id"
import { Effect, FileSystem, Option, Path, Random, Schema } from "effect"

const LEGACY_SESSION_DIRECTORY = /^[0-9a-f]{8}$/
export const ALLOCATION_LEAF = /^[0-9a-f]{4}$/
export const ALLOCATION_NAME_ATTEMPTS = 16

export const hostPlatform = Schema.decodeUnknownOption(
  Schema.Struct({ process: Schema.Struct({ platform: Schema.String }) }),
)(globalThis).pipe(
  Option.map((host) => host.process.platform),
  Option.getOrUndefined,
)

export const caseFoldedWorktrees = hostPlatform === "darwin" || hostPlatform === "win32"

export const sameWorktreeBucket = (a: string, b: string) =>
  caseFoldedWorktrees ? a.toLowerCase() === b.toLowerCase() : a === b

export const safeRepositoryDirectory = (name: string) =>
  name.length > 0 &&
  name.length <= 255 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\\") &&
  !name.includes("\0") &&
  !LEGACY_SESSION_DIRECTORY.test(caseFoldedWorktrees ? name.toLowerCase() : name) &&
  !ID.test(caseFoldedWorktrees ? name.toLowerCase() : name)

export const writeAtomic = Effect.fn("writeAtomic")(function* (
  file: string,
  content: string,
  options?: { readonly mode?: number },
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  const tmp = `${file}.${yield* Random.nextIntBetween(0, 2 ** 31)}.tmp`
  yield* fs.writeFileString(tmp, content, options?.mode === undefined ? undefined : { mode: options.mode })
  yield* fs.rename(tmp, file)
})
