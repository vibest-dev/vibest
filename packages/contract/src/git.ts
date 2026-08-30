import { oc } from "@orpc/contract";
import { Schema } from "effect";

import { toStandardSchema } from "./domain";

const CwdInput = Schema.Struct({ cwd: Schema.String });
const cwdData = toStandardSchema(CwdInput);

export const GitRepositoryBranchSchema = Schema.Struct({
  kind: Schema.Literal("repository"),
  current: Schema.Union([Schema.String, Schema.Null]),
});
export type GitRepositoryBranch = typeof GitRepositoryBranchSchema.Type;

/** Repository availability plus the current branch when the workspace is a readable Git work tree. */
export const GitBranchSchema = Schema.Union([
  GitRepositoryBranchSchema,
  Schema.Struct({ kind: Schema.Literal("not-repository") }),
  Schema.Struct({ kind: Schema.Literal("workspace-unavailable") }),
]);
export type GitBranch = typeof GitBranchSchema.Type;

export function isGitRepositoryBranch(
  branch: GitBranch | undefined,
): branch is GitRepositoryBranch {
  return branch?.kind === "repository";
}

const branchErrors = {
  GIT_FAILED: { data: cwdData },
};

export const gitContract = {
  branch: oc
    .input(toStandardSchema(CwdInput))
    .errors(branchErrors)
    .output(toStandardSchema(GitBranchSchema)),
};
