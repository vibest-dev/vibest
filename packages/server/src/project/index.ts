import { Layer } from "effect";

import type { Paths } from "../config/paths";
import { ProjectRepositoryLayer } from "./repository";
import { ProjectService, ProjectServiceLayer } from "./service";

export { ProjectRepository, ProjectRepositoryLayer } from "./repository";
export { ProjectService, ProjectServiceLayer } from "./service";

/** The project module fully wired — callers supply only a `Paths` layer. */
export const ProjectModuleLayer: Layer.Layer<ProjectService, never, Paths> =
  ProjectServiceLayer.pipe(Layer.provide(ProjectRepositoryLayer));
