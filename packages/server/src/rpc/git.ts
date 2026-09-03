import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { gitContract } from "@vibest/contract/git";
import { Effect } from "effect";

import { GitService } from "../git";
import type { RpcContext } from "./context";

const orpc = implement(gitContract).$context<RpcContext>();

export const gitRouter = orpc.router({
  status: orpc.status.effect(function* ({ input, errors }) {
    const git = yield* GitService;
    return yield* git.status(input.cwd).pipe(
      Effect.catchTags({
        WorkspacePathEscape: (error) =>
          Effect.fail(errors.PATH_ESCAPE({ data: { cwd: error.cwd, path: error.path } })),
        WorkspaceNotDirectory: (error) =>
          Effect.fail(errors.NOT_DIRECTORY({ data: { path: error.path } })),
        WorkspaceReadError: () => Effect.fail(errors.GIT_FAILED({ data: { cwd: input.cwd } })),
        GitNotRepository: (error) =>
          Effect.fail(errors.NOT_REPOSITORY({ data: { cwd: error.cwd } })),
        GitError: (error) => Effect.fail(errors.GIT_FAILED({ data: { cwd: error.cwd } })),
      }),
    );
  }),
  branch: orpc.branch.effect(function* ({ input, errors }) {
    const git = yield* GitService;
    return yield* git.branch(input.cwd).pipe(
      Effect.catchTags({
        WorkspacePathEscape: (error) =>
          Effect.fail(errors.PATH_ESCAPE({ data: { cwd: error.cwd, path: error.path } })),
        WorkspaceNotDirectory: (error) =>
          Effect.fail(errors.NOT_DIRECTORY({ data: { path: error.path } })),
        WorkspaceReadError: () => Effect.fail(errors.GIT_FAILED({ data: { cwd: input.cwd } })),
        GitNotRepository: (error) =>
          Effect.fail(errors.NOT_REPOSITORY({ data: { cwd: error.cwd } })),
        GitError: (error) => Effect.fail(errors.GIT_FAILED({ data: { cwd: error.cwd } })),
      }),
    );
  }),
  review: orpc.review.effect(function* ({ input, errors }) {
    const git = yield* GitService;
    return yield* git.review(input).pipe(
      Effect.catchTags({
        WorkspacePathEscape: (error) =>
          Effect.fail(errors.PATH_ESCAPE({ data: { cwd: error.cwd, path: error.path } })),
        WorkspaceNotDirectory: (error) =>
          Effect.fail(errors.NOT_DIRECTORY({ data: { path: error.path } })),
        WorkspaceReadError: () => Effect.fail(errors.GIT_FAILED({ data: { cwd: input.cwd } })),
        GitNotRepository: (error) =>
          Effect.fail(errors.NOT_REPOSITORY({ data: { cwd: error.cwd } })),
        GitError: (error) => Effect.fail(errors.GIT_FAILED({ data: { cwd: error.cwd } })),
        GitRefNotFound: (error) => Effect.fail(errors.REF_NOT_FOUND({ data: { ref: error.ref } })),
      }),
    );
  }),
  diff: orpc.diff.effect(function* ({ input, errors }) {
    const git = yield* GitService;
    return yield* git.diff(input).pipe(
      Effect.catchTags({
        WorkspacePathEscape: (error) =>
          Effect.fail(errors.PATH_ESCAPE({ data: { cwd: error.cwd, path: error.path } })),
        WorkspaceNotDirectory: (error) =>
          Effect.fail(errors.NOT_DIRECTORY({ data: { path: error.path } })),
        WorkspaceReadError: () => Effect.fail(errors.GIT_FAILED({ data: { cwd: input.cwd } })),
        GitNotRepository: (error) =>
          Effect.fail(errors.NOT_REPOSITORY({ data: { cwd: error.cwd } })),
        GitError: (error) => Effect.fail(errors.GIT_FAILED({ data: { cwd: error.cwd } })),
        GitRefNotFound: (error) => Effect.fail(errors.REF_NOT_FOUND({ data: { ref: error.ref } })),
        WorkspaceFileNotFound: (error) =>
          Effect.fail(errors.NOT_FOUND({ data: { path: error.path } })),
        WorkspaceNotFile: (error) => Effect.fail(errors.NOT_FOUND({ data: { path: error.path } })),
        WorkspaceBinaryFile: (error) =>
          Effect.fail(errors.BINARY_FILE({ data: { path: error.path } })),
        WorkspaceFileTooLarge: (error) =>
          Effect.fail(
            errors.FILE_TOO_LARGE({
              data: { path: error.path, size: error.size, limit: error.limit },
            }),
          ),
      }),
    );
  }),
});

export type GitRouter = typeof gitRouter;
