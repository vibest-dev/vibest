import { Effect } from "effect"

import { cursor, cursorPlatform } from "./cursor.ts"
import { harnessPlugin } from "./harness-plugin.ts"

export default Effect.runSync(harnessPlugin(cursor).pipe(Effect.provide(cursorPlatform)))
