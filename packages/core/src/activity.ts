import type { Runtime } from "@vibest/plugin"
import type { ProjectActivity } from "@vibest/protocol/rpc"
import type { AgentStatus } from "@vibest/schema/session"

const NEEDS_ATTENTION_FIRST: ReadonlyArray<ProjectActivity> = ["blocked", "done", "working"]

export const unseenDone = (status: AgentStatus, seen: Runtime.Seen | undefined): AgentStatus =>
  status === "idle" && seen !== undefined && seen.seen !== null && seen.execution > seen.seen ? "done" : status

export const projectActivity = (statuses: Iterable<AgentStatus>): ProjectActivity => {
  const present = new Set<AgentStatus>(statuses)
  return NEEDS_ATTENTION_FIRST.find((activity) => present.has(activity)) ?? "idle"
}

export const raisesSeen = (now: Runtime.Seen, execution: number) =>
  Number.isInteger(execution) &&
  execution >= 0 &&
  execution <= now.execution &&
  (now.seen === null || execution > now.seen)
