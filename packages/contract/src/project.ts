import { oc } from "@orpc/contract";
import { Schema } from "effect";

import {
  CreateProjectInputSchema,
  ListDirectoriesInputSchema,
  ListDirectoriesResultSchema,
  ProjectSchema,
  toStandardSchema,
} from "./domain";

export const projectContract = {
  list: oc.output(toStandardSchema(Schema.Array(ProjectSchema))),
  create: oc
    .input(toStandardSchema(CreateProjectInputSchema))
    .output(toStandardSchema(ProjectSchema)),
  /** Browse immediate subdirectories of `path` (default: the home directory). */
  listDirectories: oc
    .input(toStandardSchema(ListDirectoriesInputSchema))
    .output(toStandardSchema(ListDirectoriesResultSchema)),
};
