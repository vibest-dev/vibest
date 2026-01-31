import { oc } from "@orpc/contract";
import { z } from "zod";

import { BranchSchema, DiffResultSchema, GitStatusSchema } from "../types";

export const gitContract = {
  status: oc
    .input(
      z.object({
        path: z.string(),
      }),
    )
    .output(GitStatusSchema),

  fetch: oc.input(
    z.object({
      path: z.string(),
    }),
  ),

  pull: oc.input(
    z.object({
      path: z.string(),
    }),
  ),

  branches: oc
    .input(
      z.object({
        path: z.string(),
      }),
    )
    .output(z.array(BranchSchema)),

  diff: oc
    .input(
      z.object({
        path: z.string(),
        staged: z.boolean().optional(),
      }),
    )
    .output(DiffResultSchema),
};
