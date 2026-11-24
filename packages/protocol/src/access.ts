import type { RpcGroup } from "effect/rpc"

import type { VibestRpcs } from "./rpc.ts"

type Access = "open" | "session" | "agent" | "owner" | "cli" | "self" | "remote"

export const ACCESS = {
  Ping: ["open", "remote"],
  Plugins: "open",
  Concurrency: "open",
  "Harnesses.List": ["open", "remote"],
  "Agents.List": ["open", "remote"],
  "Worktree.List": ["open", "remote"],
  "Integration.Guard": "open",
  "Runtimes.Doctor": "open",
  Subscriptions: "open",
  Republish: "open",
  ExecutionEnd: "open",
  Prompt: "open",
  Spawn: "agent",
  Launch: "cli",
  List: ["agent", "remote"],
  "Session.Link": ["agent", "remote"],
  "Session.Unlink": ["agent", "remote"],
  Get: ["agent", "remote"],
  "Inbox.Subscribe": "session",
  "Inbox.Take": "session",
  Watch: ["cli", "remote"],
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
  "Project.Clone": ["agent", "remote"],
  "Project.Info": "agent",
  "Project.Search": "agent",
  Send: ["owner", "session", "remote"],
  Interrupt: ["owner", "remote"],
  Stop: ["owner", "remote"],
  Peek: ["owner", "remote"],
  Archive: ["owner", "remote"],
  "Daemon.Stop": "cli",
  "Daemon.Handoff": "cli",
  "Session.Ready": "self",
  "Agents.Outdated": "cli",
  "Agents.Restart": "cli",
  "Remote.Hello": "remote",
  "Remote.Spawn": "remote",
  "Remote.Outbox": "remote",
  "Remote.Ack": "remote",
  "Remote.Link": "remote",
  "Remote.Unlink": "remote",
  "Machine.Add": "cli",
  "Machine.Load": ["cli", "remote"],
  "Machine.List": "cli",
  "Machine.Remove": "cli",
} as const satisfies Record<RpcGroup.Rpcs<typeof VibestRpcs>["_tag"], Access | readonly Access[]>

export const UI_WS_CALLS: ReadonlySet<string> = new Set(["Watch"])

export const REMOTE_CALLS: ReadonlySet<string> = new Set(
  Object.entries(ACCESS)
    .filter(([, access]) => [access].flat().includes("remote"))
    .map(([method]) => method),
)

export const FORWARDED_CALLS: ReadonlySet<string> = new Set(
  [...REMOTE_CALLS].filter(
    (method) =>
      method !== "Ping" &&
      method !== "Harnesses.List" &&
      method !== "Agents.List" &&
      method !== "Machine.Load" &&
      method !== "Worktree.List" &&
      method !== "Project.Clone" &&
      method !== "Watch" &&
      !method.startsWith("Remote."),
  ),
)
