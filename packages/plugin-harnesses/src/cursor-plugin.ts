import { Effect } from "effect"

import { cursor } from "./cursor.ts"
import { harnessPlugin } from "./harness-plugin.ts"
import { nodePlatform } from "./node-platform.ts"

export default Effect.runSync(harnessPlugin(cursor).pipe(Effect.provide(nodePlatform)))
