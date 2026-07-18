import { oc, type } from "@orpc/contract";
import { Schema } from "effect";

import { BrowseInputSchema, BrowseResultSchema, toStandardSchema } from "./domain";

// `path` is resolved relative to `cwd` and confined within it on the server.
const CwdPathInput = Schema.Struct({
  cwd: Schema.String,
  path: Schema.String,
});

/**
 * File-system access. `readFileString` / `readDirectory` are confined to the
 * caller-supplied `cwd` (backed by `WorkspaceFSService`); `browse` is rootless —
 * a folder picker that may list any directory but returns names only, no
 * contents.
 */
export const fsContract = {
  readFileString: oc.input(toStandardSchema(CwdPathInput)).output(type<string>()),
  readDirectory: oc.input(toStandardSchema(CwdPathInput)).output(type<ReadonlyArray<string>>()),
  /** Browse immediate subdirectories of `path` (default: the home directory). */
  browse: oc
    .input(toStandardSchema(BrowseInputSchema))
    .output(toStandardSchema(BrowseResultSchema)),
};
