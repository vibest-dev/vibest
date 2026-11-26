import { Agents } from "@vibest/core/agent/registry"
import { App } from "@vibest/core/app"
import { Bus } from "@vibest/core/bus"
import { CodeMode } from "@vibest/core/codemode"
import { Database } from "@vibest/core/database/database"
import { PlatformNode } from "@vibest/core/effect/platform"
import { Harness } from "@vibest/core/harness"
import { Integration } from "@vibest/core/harness/integration"
import { Harnesses } from "@vibest/core/harness/registry"
import { Subscriptions } from "@vibest/core/harness/subscriptions"
import { Identity } from "@vibest/core/identity"
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
import { Processes } from "@vibest/core/runtime/processes"
import { Runtimes } from "@vibest/core/runtime/registry"
import { Session } from "@vibest/core/session"
import { SessionLaunch } from "@vibest/core/session/entry"
import { Starts } from "@vibest/core/session/starts"
import { SessionStore } from "@vibest/core/session/store"
import { Git } from "@vibest/core/worktree/git"
import { VibestApi } from "@vibest/protocol/api"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, Layer } from "effect"
import { Etag, HttpPlatform, HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import type { ServeError } from "effect/http/HttpServerError"

import { AdmissionLive, CallerMiddlewareLive, ProtocolMiddlewareLive } from "./gates.ts"
import { AgentHandler } from "./handlers/agent.ts"
import * as CallerChecks from "./handlers/caller.ts"
import { CodeModeHandler } from "./handlers/codemode.ts"
import { DaemonHandler, DaemonHandlers } from "./handlers/daemon.ts"
import { EventHandler } from "./handlers/event.ts"
import { HarnessHandler } from "./handlers/harness.ts"
import { HookHandler } from "./handlers/hook.ts"
import { InboxHandler } from "./handlers/inbox.ts"
import { MachineHandler } from "./handlers/machine.ts"
import { McpHandler } from "./handlers/mcp.ts"
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

export * as Server from "./server.ts"

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
  McpHandler,
  CodeModeHandler,
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
  Database.node,
  ProjectStore.node,
  SessionStore.node,
  InboxStore.node,
  RemoteStore.node,
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
  Mcp.node,
  CodeMode.node,
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
