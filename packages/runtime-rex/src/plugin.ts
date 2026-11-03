// The builtin `runtime-rex` plugin (runtime-port.md §2, §8 step 3): registers the Rex Runtime in the plugin context.
// Self-contained: it drives Rex through the `rex` CLI with node:child_process, so it loads in any host that runs the plugin API.
import * as VibestPlugin from "@vibest/plugin"
import { Effect } from "effect"

import { make } from "./runtime.ts"

export const plugin: VibestPlugin.Plugin.Plugin = VibestPlugin.Plugin.define({
  id: "runtime-rex",
  effect: (context) => Effect.flatMap(make(), context.runtime.register),
})
