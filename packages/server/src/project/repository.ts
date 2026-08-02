import { ProjectSchema } from "@vibest/contract";
import { type JsonDocument, makeJsonDocument } from "@vibest/effect-json-store";
import { Context, Effect, FileSystem, Layer, Option, Ref, Schema, Semaphore } from "effect";

import { Paths } from "../config/paths";
import type { Project } from "../types";

const ProjectsSchema = Schema.Array(ProjectSchema);

/**
 * Data access for `$VIBEST_HOME/storage/projects.json` — plain read/write of
 * `Project[]`, no business rules (those live in ProjectService).
 *
 * The document opens lazily on first use and is cached once open. Store
 * failures (corrupt file, newer version, disk trouble) offer a caller no
 * recovery, so they are defects: the failing call dies and is reported by the
 * RPC defect boundary, the daemon stays up, and the next call retries the
 * open — recovering as soon as the file is fixed.
 */
export class ProjectRepository extends Context.Service<
  ProjectRepository,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<Project>>;
    readonly save: (projects: ReadonlyArray<Project>) => Effect.Effect<void>;
  }
>()("ProjectRepository") {}

export const ProjectRepositoryLayer: Layer.Layer<
  ProjectRepository,
  never,
  Paths | FileSystem.FileSystem
> = Layer.effect(
  ProjectRepository,
  Effect.gen(function* () {
    const paths = yield* Paths;
    // Captured at layer build so the lazily-run open below needs no services.
    const fs = yield* FileSystem.FileSystem;
    const opened = yield* Ref.make(Option.none<JsonDocument<ReadonlyArray<Project>>>());
    // Serializes the first open so concurrent calls cannot seed/adopt twice.
    const openGate = yield* Semaphore.make(1);
    const document: Effect.Effect<JsonDocument<ReadonlyArray<Project>>> = openGate.withPermit(
      Effect.gen(function* () {
        const cached = yield* Ref.get(opened);
        if (Option.isSome(cached)) {
          return cached.value;
        }
        const doc = yield* makeJsonDocument({
          path: paths.projectsFile,
          schema: ProjectsSchema,
          // Pre-envelope files are the bare Project[] array.
          legacy: { schema: ProjectsSchema, migrate: (projects) => projects },
          defaults: [],
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.orDie);
        yield* Ref.set(opened, Option.some(doc));
        return doc;
      }),
    );
    return {
      list: () => document.pipe(Effect.flatMap((doc) => doc.get)),
      save: (projects) =>
        document.pipe(
          Effect.flatMap((doc) => doc.set(projects)),
          Effect.orDie,
        ),
    };
  }),
);
