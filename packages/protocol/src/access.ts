import type { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

import type { VibestApi } from "./api.ts"

type Access = "open" | "session" | "agent" | "owner" | "cli" | "self" | "remote"

type ApiGroups<A> = A extends HttpApi.HttpApi<infer _Id, infer G> ? G : never

export type EndpointId = HttpApiEndpoint.Identifier<HttpApiGroup.Endpoints<ApiGroups<VibestApi>>>

export const ACCESS = {
  "daemon.ping": ["open", "remote"],
  "daemon.concurrency": "open",
  "daemon.republish": "open",
  "daemon.stop": "cli",
  "daemon.handoff": "cli",
  "project.open": ["cli", "remote"],
  "project.create": "cli",
  "project.move": "cli",
  "project.info": "agent",
  "project.search": "agent",
  "project.clone": ["agent", "remote"],
  "session.list": ["agent", "remote"],
  "session.get": ["agent", "remote"],
  "session.peek": ["owner", "remote"],
  "session.spawn": "agent",
  "session.launch": ["cli", "remote"],
  "session.attach": "cli",
  "session.focus": "cli",
  "session.claim": "cli",
  "session.send": ["owner", "session", "remote"],
  "session.interrupt": ["owner", "remote"],
  "session.stop": ["owner", "remote"],
  "session.archive": ["owner", "remote"],
  "session.link": "agent",
  "session.unlink": "agent",
  "session.seen": "cli",
  "inbox.take": "session",
  "inbox.subscribe": "session",
  "hook.ready": "session",
  "hook.prompt": "session",
  "hook.executionEnd": "session",
  "hook.guard": "session",
  "worktree.list": ["open", "remote"],
  "agent.list": ["open", "remote"],
  "agent.outdated": "cli",
  "agent.restart": "cli",
  "harness.list": ["open", "remote"],
  "runtime.doctor": "open",
  "plugin.list": "open",
  "mcp.list": "open",
  "mcp.add": "open",
  "mcp.remove": "open",
  "mcp.connect": "open",
  "mcp.disconnect": "open",
  "mcp.tools": "open",
  "mcp.search": "open",
  "mcp.describe": "open",
  "mcp.call": "open",
  "mcp.events": "open",
  "mcp.skills": "open",
  "mcp.read": "open",
  "mcp.authStart": "open",
  "mcp.authComplete": "open",
  "mcp.authSetToken": "open",
  "mcp.authLogout": "open",
  "subscription.list": "open",
  "machine.list": "cli",
  "machine.add": "cli",
  "machine.load": ["cli", "remote"],
  "machine.remove": "cli",
  "remote.hello": "remote",
  "remote.spawn": "remote",
  "remote.outbox": "remote",
  "remote.ack": "remote",
  "remote.link": "remote",
  "remote.unlink": "remote",
  "event.subscribe": "cli",
  "watch.subscribe": ["cli", "remote"],
} as const satisfies Record<EndpointId, Access | readonly Access[]>

export const UI_CALLS: ReadonlySet<string> = new Set([
  "watch.subscribe",
  "session.launch",
  "project.open",
  "project.create",
  "session.send",
  "session.link",
  "session.unlink",
  "session.interrupt",
  "session.stop",
  "session.archive",
  "session.peek",
  "session.get",
  "session.seen",
  "machine.list",
  "harness.list",
  "agent.list",
])

export const REMOTE_CALLS: ReadonlySet<string> = new Set(
  Object.entries(ACCESS)
    .filter(([, access]) => [access].flat().includes("remote"))
    .map(([method]) => method),
)

export const FORWARDED_CALLS: ReadonlySet<string> = new Set(
  [...REMOTE_CALLS].filter(
    (method) =>
      method !== "daemon.ping" &&
      method !== "harness.list" &&
      method !== "agent.list" &&
      method !== "machine.load" &&
      method !== "worktree.list" &&
      method !== "project.clone" &&
      method !== "project.open" &&
      method !== "session.launch" &&
      method !== "watch.subscribe" &&
      !method.startsWith("remote."),
  ),
)
