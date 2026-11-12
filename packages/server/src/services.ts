import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { Git } from "@vibest/core/git"
import { Harness, Harnesses } from "@vibest/core/harness"
import { Inbox } from "@vibest/core/inbox"
import { Integration } from "@vibest/core/integration"
import { Machines } from "@vibest/core/machines"
import { Peers } from "@vibest/core/peer"
import { Plugins } from "@vibest/core/plugins"
import { Project } from "@vibest/core/project"
import { Remote } from "@vibest/core/remote"
import { SshHosts } from "@vibest/core/repository-url"
import { Runtimes } from "@vibest/core/runtimes"
import { Archive } from "@vibest/core/session/archive"
import { Delivery } from "@vibest/core/session/delivery"
import { EntrySession } from "@vibest/core/session/entry"
import { Executions } from "@vibest/core/session/executions"
import { Exits } from "@vibest/core/session/exits"
import { SessionLive } from "@vibest/core/session/live"
import { SessionLocks } from "@vibest/core/session/locks"
import { Move } from "@vibest/core/session/move"
import { Placement } from "@vibest/core/session/placement"
import { Spawn } from "@vibest/core/session/spawn"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"

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
  SshHosts.node,
  Git.node,
  SessionLocks.node,
  Executions.node,
  Placement.node,
  Move.node,
  Spawn.node,
  Archive.node,
  Delivery.node,
  Exits.node,
  Sessions.node,
  Integration.node,
  Peers.node,
  EntrySession.node,
  Machines.node,
  Remote.node,
])
