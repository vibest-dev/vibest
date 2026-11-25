import { Agents } from "@vibest/core/agents"
import { App } from "@vibest/core/app"
import { Bus } from "@vibest/core/bus"
import { Concurrency } from "@vibest/core/concurrency"
import { Db } from "@vibest/core/database/db"
import { Drain } from "@vibest/core/drain"
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
import { SessionLaunch } from "@vibest/core/session/entry"
import { Starts } from "@vibest/core/session/starts"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { VibestApi } from "@vibest/protocol/api"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, Layer } from "effect"
import { Etag, HttpPlatform, HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import type { ServeError } from "effect/http/HttpServerError"

import { AdmissionLive, CallerMiddlewareLive, ProtocolMiddlewareLive } from "./gates.ts"
import { AgentHandler } from "./handlers/agent.ts"
import * as CallerChecks from "./handlers/caller.ts"
import { DaemonHandler, DaemonHandlers } from "./handlers/daemon.ts"
import { EventHandler } from "./handlers/event.ts"
import { HarnessHandler } from "./handlers/harness.ts"
import { HookHandler } from "./handlers/hook.ts"
import { InboxHandler } from "./handlers/inbox.ts"
import { MachineHandler } from "./handlers/machine.ts"
import { PluginHandler } from "./handlers/plugin.ts"
import { ProjectHandler } from "./handlers/project.ts"
import { RemoteHandler, routingLayer } from "./handlers/remote.ts"
import { RuntimeHandler } from "./handlers/runtime.ts"
import { SessionHandler } from "./handlers/session.ts"
import { SubscriptionHandler } from "./handlers/subscription.ts"
import { WatchHandler } from "./handlers/watch.ts"
import { WorktreeHandler } from "./handlers/worktree.ts"
import * as Listing from "./listing.ts"
import { Inbound } from "./machine/inbound.ts"
import { Load } from "./machine/load.ts"
import { Machines } from "./machine/machines.ts"
import { RemoteWatch } from "./machine/remote-watch.ts"
import { Remote } from "./machine/remote.ts"
import { defectResponseLayer } from "./middleware/defect-response.ts"
import { schemaErrorLayer } from "./middleware/schema-error.ts"
import { services } from "./services.ts"
import { UpdateCheck } from "./update-check.ts"
import { WatchFeed } from "./watch-feed.ts"

export const HANDOFF_ENV = "VIBEST_HANDOFF_ENV"

export const handlersCore = Layer.mergeAll(
  DaemonHandler,
  ProjectHandler,
  SessionHandler,
  InboxHandler,
  HookHandler,
  WorktreeHandler,
  AgentHandler,
  HarnessHandler,
  RuntimeHandler,
  PluginHandler,
  SubscriptionHandler,
  MachineHandler,
  RemoteHandler,
  EventHandler,
  WatchHandler,
).pipe(Layer.provide(routingLayer.pipe(Layer.provideMerge(CallerChecks.layer))))

export const handlers = handlersCore.pipe(
  Layer.provide(Layer.merge(WatchFeed.layer.pipe(Layer.provideMerge(Listing.layer)), RemoteWatch.layer)),
)

const apiRoutes = HttpApiBuilder.layer(VibestApi, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide(handlersCore),
  Layer.provide(CallerMiddlewareLive),
  Layer.provide(AdmissionLive),
  Layer.provide(ProtocolMiddlewareLive),
  Layer.provide(schemaErrorLayer),
  Layer.merge(defectResponseLayer),
)

const unixServerLayer = HttpRouter.serve(apiRoutes).pipe(Layer.provide(Layer.merge(HttpPlatform.layer, Etag.layerWeak)))

export const layer = unixServerLayer.pipe(
  Layer.provide(Layer.merge(WatchFeed.layer.pipe(Layer.provideMerge(Listing.layer)), RemoteWatch.layer)),
)

export class HttpServerLayer extends Context.Service<HttpServerLayer, Layer.Layer<HttpServer.HttpServer, ServeError>>()(
  "vibest/HttpServerLayer",
) {}

export const httpServerLayer = LayerNode.unbound(HttpServerLayer)

export const httpServer = LayerNode.make({
  service: HttpServer.HttpServer,
  layer: Layer.unwrap(Effect.map(HttpServerLayer, (layer) => layer)),
  deps: [httpServerLayer],
})

export const handlerDeps = [
  services,
  Agents.node,
  Bus.node,
  Concurrency.node,
  Starts.node,
  Db.node,
  Drain.node,
  Git.node,
  Harness.node,
  Harnesses.node,
  DaemonHandlers.identityNode,
  Inbox.node,
  Integration.node,
  SessionLaunch.node,
  Listing.node,
  Load.node,
  Machines.node,
  RemoteWatch.node,
  Inbound.node,
  Plugins.node,
  Processes.node,
  Project.node,
  Remote.node,
  Runtimes.node,
  Session.node,
  DaemonHandlers.shutdownNode,
  RepositoryUrl.node,
  Subscriptions.node,
  UpdateCheck.node,
  WatchFeed.node,
  App.node,
  Identity.node,
  PlatformNode.childProcessSpawner,
  PlatformNode.fileSystem,
  PlatformNode.layout,
  PlatformNode.path,
] as const

export const node = LayerNode.make({
  name: "vibest/HttpServer",
  layer: unixServerLayer,
  deps: [...handlerDeps, httpServer],
})
