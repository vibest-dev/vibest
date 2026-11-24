import type { RpcGroup } from "effect/rpc"

import type { VibestRpcs } from "./rpc.ts"

type Access = "open" | "session" | "agent" | "owner" | "cli" | "self" | "peer"

export const ACCESS = {
  Ping: ["open", "peer"],
  Plugins: "open",
  Concurrency: "open",
  "Harnesses.List": ["open", "peer"],
  "Agents.List": ["open", "peer"],
  "Worktree.List": ["open", "peer"],
  "Integration.Guard": "open",
  "Runtimes.Doctor": "open",
  Subscriptions: "open",
  Republish: "open",
  ExecutionEnd: "open",
  Prompt: "open",
  Spawn: "agent",
  Launch: "cli",
  List: ["agent", "peer"],
  "Team.List": "session",
  Get: ["agent", "peer"],
  "Inbox.Subscribe": "session",
  "Inbox.Take": "session",
  Watch: ["cli", "peer"],
  Events: "cli",
  "Session.Seen": "cli",
  "Project.Open": "cli",
  "Project.Move": "cli",
  "Project.EntryPlace": "cli",
  "Project.EntrySession": "cli",
  "Project.StartEntry": "cli",
  "Project.FocusEntry": "cli",
  "Project.RunningEntry": "agent",
  "Project.StopEntry": "cli",
  "Project.Create": "cli",
  "Project.Clone": ["agent", "peer"],
  "Project.Info": "agent",
  "Project.Search": "agent",
  Send: ["owner", "session", "peer"],
  Interrupt: ["owner", "peer"],
  Stop: ["owner", "peer"],
  Peek: ["owner", "peer"],
  Remove: ["owner", "peer"],
  "Daemon.Stop": "cli",
  "Daemon.Handoff": "cli",
  "Session.Ready": "self",
  "Agents.Outdated": "cli",
  "Agents.Restart": "cli",
  "Peer.Hello": "peer",
  "Peer.Spawn": "peer",
  "Peer.Outbox": "peer",
  "Peer.Ack": "peer",
  "Machine.Add": "cli",
  "Machine.Load": ["cli", "peer"],
  "Machine.List": "cli",
  "Machine.Remove": "cli",
} as const satisfies Record<RpcGroup.Rpcs<typeof VibestRpcs>["_tag"], Access | readonly Access[]>

export const UI_WS_CALLS: ReadonlySet<string> = new Set(["Watch"])

export const PEER_CALLS: ReadonlySet<string> = new Set(
  Object.entries(ACCESS)
    .filter(([, access]) => [access].flat().includes("peer"))
    .map(([method]) => method),
)

export const FORWARDED_CALLS: ReadonlySet<string> = new Set(
  [...PEER_CALLS].filter(
    (method) =>
      method !== "Ping" &&
      method !== "Harnesses.List" &&
      method !== "Agents.List" &&
      method !== "Machine.Load" &&
      method !== "Worktree.List" &&
      method !== "Project.Clone" &&
      method !== "Watch" &&
      !method.startsWith("Peer."),
  ),
)
