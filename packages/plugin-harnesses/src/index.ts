import { agy } from "./agy.ts"
import { claude } from "./claude.ts"
import { cursor } from "./cursor.ts"
import { harnessPlugin } from "./harness-plugin.ts"
import { pi } from "./pi.ts"
import { agySubscription } from "./subscriptions/agy.ts"
import { claudeSubscription } from "./subscriptions/claude.ts"
import { piSubscription } from "./subscriptions/pi.ts"

export const piPlugin = harnessPlugin(pi, piSubscription)
export const claudePlugin = harnessPlugin(claude, claudeSubscription)
export const cursorPlugin = harnessPlugin(cursor)
export const agyPlugin = harnessPlugin(agy, agySubscription)

export { agy, claude, cursor, pi }
