import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { ProjectSchema } from "@vibest/contract";
import { makeJsonDocument } from "@vibest/effect-json-store";
import { Context, Effect, Layer, Schema } from "effect";

import { Paths } from "../config/paths";
import { type StoreReadError, StoreWriteError } from "../errors";
import type { Project } from "../types";

const ProjectsSchema = Schema.Array(ProjectSchema);

/**
 * Data access for `$VIBEST_HOME/storage/projects.json` — plain read/write of
 * `Project[]`, no business rules (those live in ProjectService).
 *
 * The document is loaded (and a missing file seeded with `[]`) when the layer
 * is built; a corrupt or unreadable file is a defect that fails startup rather
 * than a per-call error. `list` serves the in-memory cache.
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
    const document = yield* makeJsonDocument({
      path: paths.projectsFile,
      schema: ProjectsSchema,
      // Pre-envelope files are the bare Project[] array.
      legacy: { schema: ProjectsSchema, migrate: (projects) => projects },
      defaults: [],
    }).pipe(Effect.orDie);
    return {
      list: () => document.get,
      save: (projects) =>
        document
          .set(projects)
          .pipe(
            Effect.mapError((error) => new StoreWriteError({ file: error.file, cause: error })),
          ),
    };
  }),
).pipe(Layer.provide(NodeFileSystem.layer));
