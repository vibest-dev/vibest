import { claude } from "./claude.ts"
import { cursor } from "./cursor.ts"
import { harnessPlugin } from "./harness-plugin.ts"
import { pi } from "./pi.ts"

export const piPlugin = harnessPlugin(pi)
export const claudePlugin = harnessPlugin(claude)
export const cursorPlugin = harnessPlugin(cursor)

export { claude, cursor, pi }
