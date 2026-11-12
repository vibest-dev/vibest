import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { Harness, Harnesses } from "@vibest/core/harness"
import { VibestdIdentity } from "@vibest/core/identity"
import { Inbox } from "@vibest/core/inbox"
import { Integration } from "@vibest/core/integration"
import { Machines } from "@vibest/core/machines"
import { Peers } from "@vibest/core/peer"
import { Plugins } from "@vibest/core/plugins"
import { Processes } from "@vibest/core/processes"
import { Project } from "@vibest/core/project"
import { Remote } from "@vibest/core/remote"
import { SshHosts } from "@vibest/core/repository-url"
import { Runtimes } from "@vibest/core/runtimes"
import { EntrySession } from "@vibest/core/session/entry"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import * as UpdateCheckNode from "@vibest/core/update-check"
import { Git } from "@vibest/core/worktree"
import { VibestRpcs } from "@vibest/protocol/rpc"
import { Effect, Layer } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import * as SocketServer from "effect/socket/SocketServer"

import { AdmissionLive, CallerGateLive, ProtocolGateLive } from "./gates.ts"
import * as CallerChecks from "./handlers/caller.ts"
import * as DaemonHandlers from "./handlers/daemon.ts"
import { Identity, Shutdown } from "./handlers/daemon.ts"
import * as EntryHandlers from "./handlers/entry.ts"
import * as InboxHandlers from "./handlers/inbox.ts"
import * as IntegrationHandlers from "./handlers/integration.ts"
import * as ProjectHandlers from "./handlers/project.ts"
import { remoteHandlers } from "./handlers/remote.ts"
import * as SessionHandlers from "./handlers/session.ts"
import { sessionListing } from "./listing.ts"
import { services } from "./services.ts"

export { Identity, Shutdown } from "./handlers/daemon.ts"
export { WATCH_BACKLOG } from "./handlers/session.ts"
export { DRAIN_TIMEOUT } from "./stop.ts"
export { PRESENT_TIMEOUT } from "@vibest/core/session/entry"

export const HANDOFF_ENV = "VIBEST_HANDOFF_ENV"

export const handlers = VibestRpcs.toLayer(
  Effect.gen(function* () {
    const checks = yield* CallerChecks.make
    const listing = sessionListing({ db: yield* Db, sessions: yield* Sessions, runtimes: yield* Runtimes })
    const remote = yield* remoteHandlers({ ...checks, listed: listing.listed })
    return VibestRpcs.of({
      ...remote.methods,
      ...(yield* DaemonHandlers.make(checks)),
      ...(yield* SessionHandlers.make(checks, remote, listing)),
      ...(yield* InboxHandlers.make),
      ...(yield* IntegrationHandlers.make),
      ...(yield* EntryHandlers.make(checks)),
      ...(yield* ProjectHandlers.make(checks)),
    })
  }),
)

export const layer = RpcServer.layer(VibestRpcs).pipe(
  Layer.provide(Layer.mergeAll(handlers, AdmissionLive)),
  Layer.provide(CallerGateLive),
  Layer.provide(ProtocolGateLive),
  Layer.provide(RpcServer.layerProtocolSocketServer),
  Layer.provide(RpcSerialization.layerNdJsonRpc()),
)

export const socketServer = LayerNode.unbound<SocketServer.SocketServerError>()(SocketServer.SocketServer)

export const node = LayerNode.make({
  name: "vibest/RpcServer",
  layer,
  deps: [
    services,
    Bus.node,
    Db.node,
    Drain.node,
    Git.node,
    Harness.node,
    Harnesses.node,
    Identity.node,
    Inbox.node,
    Integration.node,
    EntrySession.node,
    Machines.node,
    Peers.node,
    Plugins.node,
    Processes.node,
    Project.node,
    Remote.node,
    Runtimes.node,
    Sessions.node,
    Shutdown.node,
    SshHosts.node,
    Subscriptions.node,
    UpdateCheckNode.node,
    VibestdIdentity.node,
    socketServer,
    PlatformNode.childProcessSpawner,
    PlatformNode.fileSystem,
    PlatformNode.layout,
    PlatformNode.path,
  ],
})
