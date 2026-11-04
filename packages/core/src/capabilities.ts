import type { Agent } from "@vibest/plugin"
// Who may manage (message, interrupt, archive) a session: the engine's capability check, in neutral terms. A product
// maps its callers onto `Manager` (vibest's server: the user's command line, the entry agent, a session) and turns a
// refusal into its own error.
import { Effect } from "effect"

/** Who asks: the user, a session the product gives a whole group's rights (vibest: the entry agent), or a session. */
export type Manager =
  | { readonly _tag: "User" }
  | { readonly _tag: "GroupOwner"; readonly group: string }
  | {
      readonly _tag: "Session"
      readonly sessionId: string
      readonly group: string
      readonly message: Agent.AgentDefinition["can"]["message"]
    }

/** `allowed`; `outside`: not the manager's to manage; `reportOnly`: its definition only reports to whoever started it. */
export type Verdict = "allowed" | "outside" | "reportOnly"

/** May `manager` manage session `target` (in grouping `group`)? `descends` and `shared` read provenance and groups. */
export const mayManage = (
  manager: Manager,
  target: { readonly id: string; readonly group: string },
  read: {
    /** `id` is `ancestor` or started (transitively) by it. */
    readonly descends: (id: string, ancestor: string) => Effect.Effect<boolean>
    /** `a` and `b` share a plugin-kept group. */
    readonly shared: (a: string, b: string) => Effect.Effect<boolean>
  },
): Effect.Effect<Verdict> =>
  Effect.gen(function* () {
    if (manager._tag === "User") return "allowed"
    if (target.group !== manager.group) return "outside"
    if (manager._tag === "GroupOwner") return "allowed"
    if (manager.message === "project") return "allowed"
    if (manager.message === "children" && (yield* read.descends(target.id, manager.sessionId))) return "allowed"
    if (manager.message === "group" && (yield* read.shared(target.id, manager.sessionId))) return "allowed"
    return manager.message === "report-only" ? "reportOnly" : "outside"
  })
