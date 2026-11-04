// Groups of sessions a plugin keeps (a team): a session whose agent may message its group (`can.message: "group"`)
// may send to, interrupt, peek and remove the sessions it shares a group with. In memory, as the plugin's own state is:
// a plugin rebuilds its groups when it loads again.
import type { SessionGroups } from "@vibest/plugin"
import { Context, Effect, Layer } from "effect"

export interface GroupsShape extends SessionGroups {
  /** `a` and `b` are in one group. */
  readonly shared: (a: string, b: string) => Effect.Effect<boolean>
}

export class Groups extends Context.Service<Groups, GroupsShape>()("vibest/Groups") {
  static readonly make = (): GroupsShape => {
    const groups = new Map<string, Set<string>>()
    return {
      join: (group, sessionId) =>
        Effect.sync(() => void groups.set(group, (groups.get(group) ?? new Set()).add(sessionId))),
      leave: (group, sessionId) =>
        Effect.sync(() => {
          const members = groups.get(group)
          members?.delete(sessionId)
          if (members?.size === 0) groups.delete(group)
        }),
      members: (group) => Effect.sync(() => [...(groups.get(group) ?? [])]),
      shared: (a, b) => Effect.sync(() => [...groups.values()].some((m) => m.has(a) && m.has(b))),
    }
  }

  static readonly layer = Layer.sync(Groups, () => Groups.make())
}
