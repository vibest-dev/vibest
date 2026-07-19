import { Layer } from "effect";

import { EventBusLayer } from "./events";
import { FileSystemServiceLayer } from "./fs";
import { GitServiceLayer } from "./git";
import { McpRepositoryLayer, McpServiceLayer } from "./mcp";
import { ProjectRepositoryLayer, ProjectServiceLayer } from "./project";
import { ProviderRepositoryLayer, ProviderServiceLayer } from "./provider";

export * from "./types";
export * from "./errors";
export { Paths, PathsLayer, layerPaths } from "./config/paths";
export { readJson, writeJsonAtomic } from "./infra/json-store";
export * from "./project";
export * from "./provider";
export * from "./mcp";
export * from "./events";
export * from "./fs";
export * from "./git";
export * from "./session";

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
  FileSystemServiceLayer,
  GitServiceLayer,
);
