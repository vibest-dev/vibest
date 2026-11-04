// ~/.vibest layout (SPEC §5.1). Everything on disk is derived from VIBEST_HOME plus a session id or repository key.
export { Layout, VibestCommand, shellQuote } from "@vibest/schema/layout"
export { askYesNo, interactive, writeAtomic } from "@vibest/schema/terminal"

const SESSION_ID = /^[0-9a-f]{8}$/

/** Darwin and Windows worktree volumes fold case. Linux keeps two spellings as two directories. */
const hostPlatform = (globalThis as { readonly process?: { readonly platform?: string } }).process?.platform
export const caseFoldedWorktrees = hostPlatform === "darwin" || hostPlatform === "win32"

/** Same bucket on this platform. Spelling stored on the row is unchanged. */
export const sameWorktreeBucket = (a: string, b: string) =>
  caseFoldedWorktrees ? a.toLowerCase() === b.toLowerCase() : a === b

/** One ordinary directory name. A name that is a legacy session id on this filesystem is not a bucket. */
export const safeRepositoryDirectory = (name: string) =>
  name.length > 0 &&
  name.length <= 255 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\\") &&
  !name.includes("\0") &&
  !SESSION_ID.test(caseFoldedWorktrees ? name.toLowerCase() : name)
