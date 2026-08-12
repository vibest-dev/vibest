import { oc, type } from "@orpc/contract";
import { Schema } from "effect";

import { BrowseInputSchema, BrowseResultSchema, toStandardSchema } from "./domain";

// `path` is resolved relative to `cwd` and confined within it on the server.
const CwdPathInput = Schema.Struct({
  cwd: Schema.String,
  path: Schema.String,
});

const CwdInput = Schema.Struct({ cwd: Schema.String });
const pathData = toStandardSchema(Schema.Struct({ path: Schema.String }));
const pathEscapeData = toStandardSchema(Schema.Struct({ cwd: Schema.String, path: Schema.String }));

export const WorkspaceTreeEntrySchema = Schema.Union([
  Schema.Struct({ path: Schema.String, type: Schema.Literal("directory") }),
  Schema.Struct({ path: Schema.String, type: Schema.Literal("file") }),
  Schema.Struct({
    path: Schema.String,
    type: Schema.Literal("symlink"),
    symlinkTarget: Schema.Union([
      Schema.Literal("file"),
      Schema.Literal("directory"),
      Schema.Literal("broken"),
      Schema.Literal("outside"),
      Schema.Literal("other"),
    ]),
  }),
]);
export type WorkspaceTreeEntry = typeof WorkspaceTreeEntrySchema.Type;

const WorkspaceTreeResultSchema = Schema.Struct({
  entries: Schema.Array(WorkspaceTreeEntrySchema),
});
export type WorkspaceTreeResult = typeof WorkspaceTreeResultSchema.Type;

// Typed failures the client can branch on, instead of an opaque 500.
const readFileErrors = {
  PATH_ESCAPE: { data: pathEscapeData },
  NOT_FOUND: { data: pathData },
  NOT_FILE: { data: pathData },
  FILE_TOO_LARGE: {
    data: toStandardSchema(
      Schema.Struct({ path: Schema.String, size: Schema.Number, limit: Schema.Number }),
    ),
  },
  BINARY_FILE: { data: pathData },
  READ_FAILED: { data: pathData },
};

const readTreeErrors = {
  PATH_ESCAPE: { data: pathEscapeData },
  NOT_DIRECTORY: { data: pathData },
  READ_FAILED: { data: pathData },
};

/**
 * Read-only filesystem access. File reads and workspace-tree scans are confined
 * to the caller-supplied `cwd`; `browse` is rootless because it powers the
 * project folder picker and returns directory names only.
 */
export const fsContract = {
  readFileString: oc
    .input(toStandardSchema(CwdPathInput))
    .errors(readFileErrors)
    .output(type<string>()),
  /** Recursively index a workspace for the read-only Content Panel Explorer. */
  readTree: oc
    .input(toStandardSchema(CwdInput))
    .errors(readTreeErrors)
    .output(toStandardSchema(WorkspaceTreeResultSchema)),
  /** Browse immediate subdirectories of `path` (default: the home directory). Hidden directories are opt-in. */
  browse: oc
    .input(toStandardSchema(BrowseInputSchema))
    .errors({ READ_FAILED: { data: pathData } })
    .output(toStandardSchema(BrowseResultSchema)),
};
