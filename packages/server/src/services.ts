import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { Drain } from "@vibest/core/drain"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { Git } from "@vibest/core/git"
import { Harness } from "@vibest/core/harness"
import { Harnesses } from "@vibest/core/harnesses"
import { Inbox } from "@vibest/core/inbox"
import { Integration } from "@vibest/core/integration"
import { Plugins } from "@vibest/core/plugin"
import { Project } from "@vibest/core/project"
import { RepositoryUrl } from "@vibest/core/repository-url"
import { Runtimes } from "@vibest/core/runtimes"
import { Session } from "@vibest/core/session"
import { Archive } from "@vibest/core/session/archive"
import { Delivery } from "@vibest/core/session/delivery"
import { EntrySession } from "@vibest/core/session/entry"
import { Executions } from "@vibest/core/session/executions"
import { Exits } from "@vibest/core/session/exits"
import { SessionLive } from "@vibest/core/session/live"
import { SessionLocks } from "@vibest/core/session/locks"
import { Move } from "@vibest/core/session/move"
import { Placement } from "@vibest/core/session/placement"
import { Reconcile } from "@vibest/core/session/reconcile"
import { Restart } from "@vibest/core/session/restart"
import { Spawn } from "@vibest/core/session/spawn"
import { Subscriptions } from "@vibest/core/subscriptions/service"

import { Machines } from "./machine/machines.ts"
import { Peers } from "./machine/peer.ts"
import { Remote } from "./machine/remote.ts"

export const services = LayerNode.group([
  Bus.node,
  SessionLive.node,
  Drain.node,
  Harnesses.node,
  Runtimes.node,
  Db.node,
  Harness.node,
  Project.node,
  Inbox.node,
  Subscriptions.node,
  Plugins.node,
  RepositoryUrl.node,
  Git.node,
  SessionLocks.node,
  Executions.node,
  Placement.node,
  Move.node,
  Spawn.node,
  Archive.node,
  Delivery.node,
  Exits.node,
  Reconcile.node,
  Restart.node,
  Session.node,
  Integration.node,
  Peers.node,
  EntrySession.node,
  Machines.node,
  Remote.node,
])
