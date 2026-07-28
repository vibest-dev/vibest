import { Context, Effect, Layer } from "effect";

import { Paths } from "../config/paths";
import type { StoreReadError, StoreWriteError } from "../errors";
import { readJson, writeJsonAtomic, type JsonStorePlatform } from "../infra/json-store";
import type { Project } from "../types";

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

export const ProjectRepositoryLayer: Layer.Layer<
  ProjectRepository,
  never,
  Paths | JsonStorePlatform
> = Layer.effect(
  ProjectRepository,
  Effect.gen(function* () {
    const paths = yield* Paths;
    // Bind the platform services once so the methods below stay R-free; the
    // Layer's R carries the requirement to the composition root instead.
    const platform = yield* Effect.context<JsonStorePlatform>();
    return {
      list: () =>
        readJson<ReadonlyArray<Project>>(paths.projectsFile, []).pipe(Effect.provide(platform)),
      save: (projects) =>
        writeJsonAtomic(paths.projectsFile, projects).pipe(Effect.provide(platform)),
    };
  }),
);
