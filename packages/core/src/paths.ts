import { ID } from "@vibest/schema/id"
import { Option, Schema } from "effect"

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
