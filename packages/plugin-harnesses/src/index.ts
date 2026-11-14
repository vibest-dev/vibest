import { claude } from "./claude.ts"
import { cursor } from "./cursor.ts"
import { harnessPlugin } from "./harness-plugin.ts"
import { pi } from "./pi.ts"
import { claudeSubscription } from "./subscriptions/claude.ts"
import { piSubscription } from "./subscriptions/pi.ts"

export const piPlugin = harnessPlugin(pi, piSubscription)
export const claudePlugin = harnessPlugin(claude, claudeSubscription)

export { claude, cursor, pi }
