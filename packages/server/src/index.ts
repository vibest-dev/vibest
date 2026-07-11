import { Layer } from "effect";

import { EventBusLayer } from "./events/index.js";
import { FSServiceLayer } from "./fs/index.js";
import { GitServiceLayer } from "./git/index.js";
import { McpRepositoryLayer, McpServiceLayer } from "./mcp/index.js";
import { ProjectRepositoryLayer, ProjectServiceLayer } from "./project/index.js";
import { ProviderRepositoryLayer, ProviderServiceLayer } from "./provider/index.js";

export * from "./types/index.js";
export * from "./errors.js";
export { Paths, PathsLayer, layerPaths } from "./config/paths.js";
export { readJson, writeJsonAtomic } from "./infra/json-store.js";
export * from "./project/index.js";
export * from "./provider/index.js";
export * from "./mcp/index.js";
export * from "./events/index.js";
export * from "./fs/index.js";
export * from "./git/index.js";
export * from "./session/index.js";

/**
 * The domain services composed into one root layer, with their repositories
 * provided. Callers still supply a `Paths` layer (default `PathsLayer`, or
 * `layerPaths(dir)` in tests).
 *
 * Adapters / session runtime / pty / the oRPC transport are not part of this
 * slice yet.
 */
export const HarnessAgentDomainLayer = Layer.mergeAll(
  ProjectServiceLayer.pipe(Layer.provide(ProjectRepositoryLayer)),
  ProviderServiceLayer.pipe(Layer.provide(ProviderRepositoryLayer)),
  McpServiceLayer.pipe(Layer.provide(McpRepositoryLayer)),
  EventBusLayer,
  FSServiceLayer,
  GitServiceLayer,
);
