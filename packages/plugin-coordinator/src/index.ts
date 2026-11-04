// The default orchestration (architecture.md §1): one main agent per project directs workers it starts. A plugin the
// product bundles and loads first, so the engine itself knows no main agent: it reads what this plugin defines.
// Another plugin adds kinds of its own (a `lead` that spawns, a `peer` that messages the project) with the same call.
import { Plugin, type SessionActions } from "@vibest/plugin"
import { Effect } from "effect"

import { COORDINATOR_RULES } from "./rules.ts"

/** The main agent (`vibest`): inspects, edits nothing, starts and manages the sessions of its project. */
export const COORDINATOR = {
  name: "coordinator",
  tools: "inspect",
  can: { spawn: true, message: "project" },
  entry: true,
  skills: ["delegate", "pipeline"],
  rules: COORDINATOR_RULES,
} as const

/** A worker (`vibest run`): works in its own worktree and reports to whoever started it. */
export const GENERAL = {
  name: "general",
  tools: "full",
  can: { spawn: false, message: "report-only" },
} as const

/**
 * `vibest run --archive-on-completion` (SPEC §8.6b): once a completed result reached whom it went to, archive the
 * session as `vibest archive` would, unless it has work again. Only what was kept, left over or failed is told (each
 * notice is a turn for whoever gets it); a clean archive is not.
 */
const archiveOnCompletion = (session: SessionActions, id: string) =>
  session.archive({ as: null, id }).pipe(
    Effect.flatMap((done) => {
      const flag = "(vibest run --archive-on-completion)"
      if (done.outcome === "busy") return Effect.void
      if (done.outcome === "skipped")
        return session.notice({ about: id, kind: "archived", text: `${id} not archived ${flag}: ${done.reason}` })
      const kept = done.reasons.length > 0 ? ` Kept because: ${done.reasons.join("; ")}.` : ""
      const again = done.processes === "exited" ? "" : ` Run vibest archive ${id} again to check.`
      if (!kept && !again) return Effect.void
      return session.notice({
        about: id,
        kind: "archived",
        text: `${id} archived ${flag}: terminal ${done.pane}, worktree ${done.worktree} at ${done.path}, branch ${done.branch ?? "(none)"} kept.${kept}${again}`,
      })
    }),
    Effect.catchTag("ActionRefused", (e) =>
      session.notice({
        about: id,
        kind: "archived",
        text: `${id} auto-archive failed: ${e.reason}; run vibest archive ${id}`,
      }),
    ),
    Effect.ignore,
  )

export const coordinatorPlugin = Plugin.define({
  id: "coordinator",
  effect: (context) =>
    Effect.gen(function* () {
      yield* context.agent.define(COORDINATOR)
      yield* context.agent.define(GENERAL)
      yield* context.agent.hook("delivered", (e) =>
        e.archiveOnCompletion && e.status === "completed"
          ? archiveOnCompletion(context.session, e.sessionId)
          : Effect.void,
      )
    }),
})
