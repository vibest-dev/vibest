import type { Runtime } from "@vibest/plugin"
import type { ProjectActivity } from "@vibest/protocol/rpc"
import type { AgentStatus } from "@vibest/schema/session"

const NEEDS_ATTENTION_FIRST: ReadonlyArray<ProjectActivity> = ["blocked", "done", "working"]

export const unseenDone = (status: AgentStatus, seen: Runtime.Seen | undefined): AgentStatus =>
  status === "idle" && seen !== undefined && seen.seen !== null && seen.finished > seen.seen ? "done" : status

export const projectActivity = (statuses: Iterable<AgentStatus>): ProjectActivity => {
  const present = new Set<AgentStatus>(statuses)
  return NEEDS_ATTENTION_FIRST.find((activity) => present.has(activity)) ?? "idle"
}

export const raisesSeen = (now: Runtime.Seen, finished: number) =>
  Number.isInteger(finished) && finished >= 0 && finished <= now.finished && (now.seen === null || finished > now.seen)
