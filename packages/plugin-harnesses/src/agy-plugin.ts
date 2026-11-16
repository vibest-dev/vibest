import { Effect } from "effect"

import { agy } from "./agy.ts"
import { harnessPlugin } from "./harness-plugin.ts"
import { nodePlatform } from "./node-platform.ts"

export default Effect.runSync(harnessPlugin(agy).pipe(Effect.provide(nodePlatform)))
