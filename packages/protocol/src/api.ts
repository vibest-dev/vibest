import { PROTOCOL } from "@vibest/schema/version"
import { HttpApi, OpenApi } from "effect/http-api"

import { AgentGroup } from "./groups/agent.ts"
import { DaemonGroup } from "./groups/daemon.ts"
import { EventGroup } from "./groups/event.ts"
import { HarnessGroup } from "./groups/harness.ts"
import { HookGroup } from "./groups/hook.ts"
import { InboxGroup } from "./groups/inbox.ts"
import { MachineGroup } from "./groups/machine.ts"
import { McpGroup } from "./groups/mcp.ts"
import { PluginGroup } from "./groups/plugin.ts"
import { ProjectGroup } from "./groups/project.ts"
import { RemoteGroup } from "./groups/remote.ts"
import { RuntimeGroup } from "./groups/runtime.ts"
import { SessionGroup } from "./groups/session.ts"
import { SubscriptionGroup } from "./groups/subscription.ts"
import { WatchGroup } from "./groups/watch.ts"
import { WorktreeGroup } from "./groups/worktree.ts"
import { SchemaErrorMiddleware } from "./middleware.ts"

export const VibestApi = HttpApi.make("server")
  .add(DaemonGroup)
  .add(ProjectGroup)
  .add(SessionGroup)
  .add(InboxGroup)
  .add(HookGroup)
  .add(WorktreeGroup)
  .add(AgentGroup)
  .add(HarnessGroup)
  .add(RuntimeGroup)
  .add(PluginGroup)
  .add(McpGroup)
  .add(SubscriptionGroup)
  .add(MachineGroup)
  .add(RemoteGroup)
  .add(EventGroup)
  .add(WatchGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "vibest HttpApi",
      version: String(PROTOCOL),
    }),
  )
  .middleware(SchemaErrorMiddleware)

export type VibestApi = typeof VibestApi
