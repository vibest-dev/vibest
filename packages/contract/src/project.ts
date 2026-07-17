import { oc } from "@orpc/contract";
import { Schema } from "effect";

import { serverErrors, toStandardSchema } from "./domain";

export const ProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
  createdAt: Schema.String,
});
export type Project = typeof ProjectSchema.Type;

export const CreateProjectInputSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  // Defaults to the directory's basename when omitted.
  name: Schema.optionalKey(Schema.String),
});
export type CreateProjectInput = typeof CreateProjectInputSchema.Type;

export const ListProjectsOutputSchema = Schema.Struct({ projects: Schema.Array(ProjectSchema) });
export type ListProjectsOutput = typeof ListProjectsOutputSchema.Type;

const base = oc.errors(serverErrors);

export const projectContract = {
  create: base
    .input(toStandardSchema(CreateProjectInputSchema))
    .output(toStandardSchema(ProjectSchema)),
  list: base.output(toStandardSchema(ListProjectsOutputSchema)),
};
