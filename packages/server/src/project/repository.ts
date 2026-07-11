import { Context, Effect, Layer } from "effect";

import type { StoreReadError, StoreWriteError } from "../errors";
import type { Project } from "../types";

import { Paths } from "../config/paths";
import { readJson, writeJsonAtomic } from "../infra/json-store";

/**
 * Data access for `$VIBEST_HOME/storage/projects.json` — plain read/write of
 * `Project[]`, no business rules (those live in ProjectService).
 */
export class ProjectRepository extends Context.Service<
  ProjectRepository,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<Project>, StoreReadError>;
    readonly save: (projects: ReadonlyArray<Project>) => Effect.Effect<void, StoreWriteError>;
  }
>()("ProjectRepository") {}

export const ProjectRepositoryLayer: Layer.Layer<ProjectRepository, never, Paths> = Layer.effect(
  ProjectRepository,
  Effect.gen(function* () {
    const paths = yield* Paths;
    return {
      list: () => readJson<ReadonlyArray<Project>>(paths.projectsFile, []),
      save: (projects) => writeJsonAtomic(paths.projectsFile, projects),
    };
  }),
);
