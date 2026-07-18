import { oc, type } from "@orpc/contract";
import { Schema } from "effect";

import { toStandardSchema } from "./domain";

// `path` is resolved relative to `cwd` and confined within it on the server.
const CwdPathInput = Schema.Struct({
  cwd: Schema.String,
  path: Schema.String,
});

/**
 * Read-only file access, backed by the server's `WorkspaceFSService`. Every read
 * is confined to the caller-supplied `cwd`.
 */
export const fsContract = {
  readFileString: oc.input(toStandardSchema(CwdPathInput)).output(type<string>()),
  readDirectory: oc.input(toStandardSchema(CwdPathInput)).output(type<ReadonlyArray<string>>()),
};
