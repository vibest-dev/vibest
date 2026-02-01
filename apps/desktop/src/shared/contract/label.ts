import { oc } from "@orpc/contract";
import { z } from "zod";

import { LabelSchema } from "../types";

export const labelContract = {
  // List labels for repository
  list: oc
    .input(z.object({ repositoryId: z.string() }))
    .output(z.array(LabelSchema)),

  // Create label
  create: oc
    .input(
      z.object({
        repositoryId: z.string(),
        name: z.string().min(1).max(50),
        color: z.string().regex(/^[0-9A-Fa-f]{6}$/),
        description: z.string().max(200).optional(),
      }),
    )
    .output(LabelSchema),

  // Update label
  update: oc
    .input(
      z.object({
        repositoryId: z.string(),
        labelId: z.string(),
        name: z.string().min(1).max(50).optional(),
        color: z.string().regex(/^[0-9A-Fa-f]{6}$/).optional(),
        description: z.string().max(200).optional(),
      }),
    )
    .output(LabelSchema),

  // Delete label
  delete: oc
    .input(
      z.object({
        repositoryId: z.string(),
        labelId: z.string(),
        force: z.boolean().default(false),
      }),
    )
    .output(
      z.object({
        deletedFromTasks: z.number(),
      }),
    ),
};
