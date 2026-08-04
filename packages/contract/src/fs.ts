import { oc, type } from "@orpc/contract";
import { Schema } from "effect";

import { BrowseInputSchema, BrowseResultSchema, toStandardSchema } from "./domain";

// `path` is resolved relative to `cwd` and confined within it on the server.
const CwdPathInput = Schema.Struct({
  cwd: Schema.String,
  path: Schema.String,
});

const pathData = toStandardSchema(Schema.Struct({ path: Schema.String }));

// Typed failures the client can branch on, instead of an opaque 500.
const readErrors = {
  PATH_ESCAPE: {
    data: toStandardSchema(Schema.Struct({ cwd: Schema.String, path: Schema.String })),
  },
  NOT_FILE: { data: pathData },
  FILE_TOO_LARGE: {
    data: toStandardSchema(
      Schema.Struct({ path: Schema.String, size: Schema.Number, limit: Schema.Number }),
    ),
  },
  BINARY_FILE: { data: pathData },
  READ_FAILED: { data: pathData },
};

/**
 * File-system access. `readFileString` is confined to the caller-supplied `cwd`
 * (backed by `FileSystemService`); `browse` is rootless — a folder picker that
 * may list any directory but returns names only, no contents.
 */
export const fsContract = {
  readFileString: oc
    .input(toStandardSchema(CwdPathInput))
    .errors(readErrors)
    .output(type<string>()),
  /** Browse immediate subdirectories of `path` (default: the home directory). Hidden directories are opt-in. */
  browse: oc
    .input(toStandardSchema(BrowseInputSchema))
    .errors({ READ_FAILED: { data: pathData } })
    .output(toStandardSchema(BrowseResultSchema)),
};
