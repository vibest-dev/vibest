import { Layer } from "effect";

import { EventBusLayer } from "./events";
import { FileSystemServiceLayer } from "./fs";
import { GitServiceLayer } from "./git";
import { ProjectRepositoryLayer, ProjectServiceLayer } from "./project";

export * from "./types";
export * from "./errors";
export { Paths, PathsLayer, layerPaths } from "./config/paths";
export * from "./project";
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
  EventBusLayer,
  FileSystemServiceLayer,
  GitServiceLayer,
);
