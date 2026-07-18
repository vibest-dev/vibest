import { oc } from "@orpc/contract";
import { Schema } from "effect";

import { CreateProjectInputSchema, ProjectSchema, toStandardSchema } from "./domain";

export const projectContract = {
  list: oc.output(toStandardSchema(Schema.Array(ProjectSchema))),
  create: oc
    .input(toStandardSchema(CreateProjectInputSchema))
    .output(toStandardSchema(ProjectSchema)),
};
