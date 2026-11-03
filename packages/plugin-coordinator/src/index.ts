// The default orchestration (architecture.md §1): one main agent per project directs workers it starts. A plugin the
// product bundles and loads first, so the engine itself knows no main agent: it reads what this plugin defines.
// Another plugin adds kinds of its own (a `lead` that spawns, a `peer` that messages the project) with the same call.
import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"

/** The main agent (`vibest`): inspects, edits nothing, starts and manages the sessions of its project. */
export const COORDINATOR = {
  name: "coordinator",
  tools: "inspect",
  can: { spawn: true, message: "project" },
} as const

/** A worker (`vibest run`): works in its own worktree and reports to whoever started it. */
export const GENERAL = {
  name: "general",
  tools: "full",
  can: { spawn: false, message: "report-only" },
} as const

export const coordinatorPlugin = Plugin.define({
  id: "coordinator",
  effect: (context) =>
    Effect.gen(function* () {
      yield* context.agent.define(COORDINATOR)
      yield* context.agent.define(GENERAL)
    }),
})
