import { oc } from "@orpc/contract";
import { Schema } from "effect";

import { toStandardSchema } from "./domain";

const CwdInput = Schema.Struct({ cwd: Schema.String });

/** Current HEAD name when the workspace is a git work tree; otherwise null. */
export const GitBranchSchema = Schema.Struct({
  current: Schema.Union([Schema.String, Schema.Null]),
});
export type GitBranch = typeof GitBranchSchema.Type;

export const gitContract = {
  branch: oc.input(toStandardSchema(CwdInput)).output(toStandardSchema(GitBranchSchema)),
};
