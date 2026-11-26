import { Bus } from "@vibest/core/bus"
import { CodeMode } from "@vibest/core/codemode"
import { Database } from "@vibest/core/database/database"
import { Harness } from "@vibest/core/harness"
import { Integration } from "@vibest/core/harness/integration"
import { Harnesses } from "@vibest/core/harness/registry"
import { Subscriptions } from "@vibest/core/harness/subscriptions"
import { Inbox } from "@vibest/core/inbox"
import { InboxStore } from "@vibest/core/inbox/store"
import { Mcp } from "@vibest/core/mcp"
import { Plugins } from "@vibest/core/plugin"
import { Project } from "@vibest/core/project"
import { RepositoryUrl } from "@vibest/core/project/repository-url"
import { ProjectStore } from "@vibest/core/project/store"
import { RemoteStore } from "@vibest/core/remote/store"
import { Concurrency } from "@vibest/core/runtime/concurrency"
import { Drain } from "@vibest/core/runtime/drain"
import { Runtimes } from "@vibest/core/runtime/registry"
import { Session } from "@vibest/core/session"
import { Archive } from "@vibest/core/session/archive"
import { Delivery } from "@vibest/core/session/delivery"
import { SessionLaunch } from "@vibest/core/session/entry"
import { Executions } from "@vibest/core/session/executions"
import { Exits } from "@vibest/core/session/exits"
import { SessionLive } from "@vibest/core/session/live"
import { SessionLocks } from "@vibest/core/session/locks"
import { Placement } from "@vibest/core/session/placement"
import { Reconcile } from "@vibest/core/session/reconcile"
import { Restart } from "@vibest/core/session/restart"
import { Spawn } from "@vibest/core/session/spawn"
import { Starts } from "@vibest/core/session/starts"
import { SessionStore } from "@vibest/core/session/store"
import { ToolOutput } from "@vibest/core/tool-output"
import { Git } from "@vibest/core/worktree/git"
import { LayerNode } from "@vibest/util/layer-node"

import * as Listing from "./listing.ts"
import { Inbound } from "./machine/inbound.ts"
import { Load } from "./machine/load.ts"
import { Machines } from "./machine/machines.ts"
import { RemoteWatch } from "./machine/remote-watch.ts"
import { Remote } from "./machine/remote.ts"
import { WatchFeed } from "./watch-feed.ts"

export const services = LayerNode.group([
  Bus.node,
  Concurrency.node,
  Starts.node,
  SessionLive.node,
  Drain.node,
  Harnesses.node,
  Runtimes.node,
  Database.node,
  ProjectStore.node,
  SessionStore.node,
  InboxStore.node,
  RemoteStore.node,
  Harness.node,
  Project.node,
  Inbox.node,
  Subscriptions.node,
  Plugins.node,
  Mcp.node,
  ToolOutput.node,
  CodeMode.node,
  RepositoryUrl.node,
  Git.node,
  SessionLocks.node,
  Executions.node,
  Placement.node,
  Spawn.node,
  Archive.node,
  Delivery.node,
  Exits.node,
  Reconcile.node,
  Restart.node,
  Session.node,
  Integration.node,
  Inbound.node,
  SessionLaunch.node,
  Load.node,
  Machines.node,
  RemoteWatch.node,
  Remote.node,
  Listing.node,
  WatchFeed.node,
])
