import { randomUUID } from "node:crypto";
import { basename, resolve as resolvePath } from "node:path";

import { Context, Effect, Layer } from "effect";

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
    readonly findByPath: (path: string) => Effect.Effect<Project | undefined, StoreReadError>;
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

export const ProjectServiceLayer: Layer.Layer<ProjectService, never, ProjectRepository> =
  Layer.effect(
    ProjectService,
    Effect.gen(function* () {
      const repo = yield* ProjectRepository;

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

        findByPath: (path) =>
          Effect.gen(function* () {
            const projects = yield* repo.list();
            const target = resolvePath(path);
            return projects.find((p) => resolvePath(p.path) === target);
          }),

        create: (input) =>
          Effect.gen(function* () {
            const normalized = resolvePath(input.path);
            const projects = yield* repo.list();
            // Reuse an existing project pointing at the same path.
            const existing = projects.find((p) => resolvePath(p.path) === normalized);
            if (existing !== undefined) return existing;

            const project: Project = {
              id: randomUUID(),
              name: input.name ?? basename(normalized),
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
