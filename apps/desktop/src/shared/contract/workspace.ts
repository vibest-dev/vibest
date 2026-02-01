import { oc } from "@orpc/contract";
import { z } from "zod";

import { RepositorySchema, WorktreeSchema } from "../types";

export const workspaceContract = {
  // List all repositories and worktrees
  list: oc.output(
    z.object({
      repositories: z.array(RepositorySchema),
      worktreesByRepository: z.record(z.string(), z.array(WorktreeSchema)),
    }),
  ),

  // Repository operations
  addRepository: oc
    .input(
      z.object({
        path: z.string(),
        defaultBranch: z.string(),
      }),
    )
    .output(RepositorySchema),

  cloneRepository: oc
    .input(
      z.object({
        url: z.string(),
        targetPath: z.string(),
        defaultBranch: z.string().optional(),
      }),
    )
    .output(RepositorySchema),

  removeRepository: oc.input(
    z.object({
      repositoryId: z.string(),
    }),
  ),

  getDefaultBranch: oc
    .input(
      z.object({
        path: z.string(),
      }),
    )
    .output(z.string()),

  getBranches: oc
    .input(
      z.object({
        path: z.string(),
      }),
    )
    .output(
      z.array(
        z.object({
          name: z.string(),
          current: z.boolean(),
          remote: z.string(),
        }),
      ),
    ),

  // Worktree operations (legacy - worktrees are now created via task.create)
  removeWorktree: oc.input(
    z.object({
      worktreeId: z.string(),
      force: z.boolean().optional(),
    }),
  ),

  archiveWorktree: oc.input(
    z.object({
      worktreeId: z.string(),
      commitFirst: z.boolean().optional(),
    }),
  ),

  openWorktree: oc.input(
    z.object({
      worktreeId: z.string(),
    }),
  ),
};
