import path from "node:path";

import { Context, Crypto, Effect, Layer } from "effect";

import { ProjectNotFound, type StoreReadError, type StoreWriteError } from "../errors";
import type { Project } from "../types";
import { ProjectRepository } from "./repository";

/**
 * `project` module: list / create (path-dedup) / remove / findById. Business
 * rules live here; persistence is delegated to the repo.
 */
export class ProjectService extends Context.Service<
  ProjectService,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<Project>, StoreReadError>;
    readonly findById: (id: string) => Effect.Effect<Project, StoreReadError | ProjectNotFound>;
    /** The project registered at a workspace path, if any (paths are resolved). */
    readonly findByPath: (workspace: string) => Effect.Effect<Project | undefined, StoreReadError>;
    /** `name` defaults to the folder's basename. */
    readonly create: (input: {
      readonly name?: string;
      readonly path: string;
    }) => Effect.Effect<Project, StoreReadError | StoreWriteError>;
    readonly remove: (
      id: string,
    ) => Effect.Effect<void, StoreReadError | StoreWriteError | ProjectNotFound>;
  }
>()("ProjectService") {}

export const ProjectServiceLayer: Layer.Layer<
  ProjectService,
  never,
  ProjectRepository | Crypto.Crypto
> = Layer.effect(
  ProjectService,
  Effect.gen(function* () {
    const repo = yield* ProjectRepository;
    const crypto = yield* Crypto.Crypto;
    // A platform RNG that cannot produce a uuid is a defect, not a domain
    // failure — keep it out of the service's error channel.
    const newId = crypto.randomUUIDv4.pipe(Effect.orDie);

    return {
      list: () => repo.list(),

      findById: (id) =>
        Effect.gen(function* () {
          const projects = yield* repo.list();
          const found = projects.find((p) => p.id === id);
          if (found === undefined) {
            return yield* Effect.fail(new ProjectNotFound({ projectId: id }));
          }
          return found;
        }),

      findByPath: (workspace) =>
        Effect.gen(function* () {
          const projects = yield* repo.list();
          const target = path.resolve(workspace);
          return projects.find((p) => path.resolve(p.path) === target);
        }),

      create: (input) =>
        Effect.gen(function* () {
          const normalized = path.resolve(input.path);
          const projects = yield* repo.list();
          // Reuse an existing project pointing at the same path.
          const existing = projects.find((p) => path.resolve(p.path) === normalized);
          if (existing !== undefined) return existing;

          const project: Project = {
            id: yield* newId,
            name: input.name ?? path.basename(normalized),
            path: normalized,
            createdAt: new Date().toISOString(),
          };
          yield* repo.save([...projects, project]);
          return project;
        }),

      remove: (id) =>
        Effect.gen(function* () {
          const projects = yield* repo.list();
          const target = projects.find((p) => p.id === id);
          if (target === undefined) {
            return yield* Effect.fail(new ProjectNotFound({ projectId: id }));
          }
          yield* repo.save(projects.filter((p) => p.id !== id));
        }),
    };
  }),
);
