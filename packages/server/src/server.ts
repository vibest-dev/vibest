import { Agents } from "@vibest/core/agents"
import { App } from "@vibest/core/app"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { Drain } from "@vibest/core/drain"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { PlatformNode } from "@vibest/core/effect/platform"
import { Git } from "@vibest/core/git"
import { Harness } from "@vibest/core/harness"
import { Harnesses } from "@vibest/core/harnesses"
import { Identity } from "@vibest/core/identity"
import { Inbox } from "@vibest/core/inbox"
import { Integration } from "@vibest/core/integration"
import { Plugins } from "@vibest/core/plugin"
import { Processes } from "@vibest/core/processes"
import { Project } from "@vibest/core/project"
import { RepositoryUrl } from "@vibest/core/repository-url"
import { Runtimes } from "@vibest/core/runtimes"
import { Session } from "@vibest/core/session"
import { EntrySession } from "@vibest/core/session/entry"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { VibestRpcs } from "@vibest/protocol/rpc"
import { Context, Effect, Layer } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import * as SocketServer from "effect/socket/SocketServer"

import { AdmissionLive, CallerGateLive, ProtocolGateLive } from "./gates.ts"
import * as CallerChecks from "./handlers/caller.ts"
import * as DaemonHandlers from "./handlers/daemon.ts"
import { Identity as HandlerIdentity, Shutdown } from "./handlers/daemon.ts"
import * as EntryHandlers from "./handlers/entry.ts"
import * as InboxHandlers from "./handlers/inbox.ts"
import * as IntegrationHandlers from "./handlers/integration.ts"
import * as ProjectHandlers from "./handlers/project.ts"
import { remoteHandlers } from "./handlers/remote.ts"
import * as SessionHandlers from "./handlers/session.ts"
import { sessionListing } from "./listing.ts"
import { Machines } from "./machine/machines.ts"
import { Peers } from "./machine/peer.ts"
import { Remote } from "./machine/remote.ts"
import { services } from "./services.ts"
import { UpdateCheck } from "./update-check.ts"

export const HANDOFF_ENV = "VIBEST_HANDOFF_ENV"

export const handlers = VibestRpcs.toLayer(
  Effect.gen(function* () {
    const checks = yield* CallerChecks.make
    const listing = sessionListing({
      db: yield* Db,
      sessions: yield* Session.Service,
      runtimes: yield* Runtimes.Service,
    })
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

export class SocketServerLayer extends Context.Service<
  SocketServerLayer,
  Layer.Layer<SocketServer.SocketServer, SocketServer.SocketServerError>
>()("vibest/SocketServerLayer") {}
export const socketServerLayer = LayerNode.unbound(SocketServerLayer)
export const socketServer = LayerNode.make({
  service: SocketServer.SocketServer,
  layer: Layer.unwrap(Effect.map(SocketServerLayer, (layer) => layer)),
  deps: [socketServerLayer],
})

export const node = LayerNode.make({
  name: "vibest/RpcServer",
  layer,
  deps: [
    services,
    Agents.node,
    Bus.node,
    Db.node,
    Drain.node,
    Git.node,
    Harness.node,
    Harnesses.node,
    HandlerIdentity.node,
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
    Session.node,
    Shutdown.node,
    RepositoryUrl.node,
    Subscriptions.node,
    UpdateCheck.node,
    App.node,
    Identity.node,
    socketServer,
    PlatformNode.childProcessSpawner,
    PlatformNode.fileSystem,
    PlatformNode.layout,
    PlatformNode.path,
  ],
})
