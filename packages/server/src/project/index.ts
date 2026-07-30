import { Layer } from "effect";

import type { Paths } from "../config/paths";
import type { JsonStorePlatform } from "../infra/json-store";
import { ProjectRepositoryLayer } from "./repository";
import { ProjectService, ProjectServiceLayer } from "./service";

export { ProjectRepository, ProjectRepositoryLayer } from "./repository";
export { ProjectService, ProjectServiceLayer } from "./service";

/**
 * The project module fully wired — callers supply a `Paths` layer plus the
 * platform services the repository and id generation run on.
 */
export const ProjectModuleLayer: Layer.Layer<ProjectService, never, Paths | JsonStorePlatform> =
  ProjectServiceLayer.pipe(Layer.provide(ProjectRepositoryLayer));
