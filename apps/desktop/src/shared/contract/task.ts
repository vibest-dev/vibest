import { oc } from "@orpc/contract";
import { z } from "zod";

import { TaskSchema, WorktreeSchema } from "../types";

export const taskContract = {
	// List tasks for a repository
	list: oc.input(z.object({ repositoryId: z.string() })).output(
		z.array(
			z.object({
				task: TaskSchema,
				worktrees: z.array(WorktreeSchema),
			}),
		),
	),

	// Get single task with worktrees
	get: oc.input(z.object({ taskId: z.string() })).output(
		z.object({
			task: TaskSchema,
			worktrees: z.array(WorktreeSchema),
		}),
	),

	// Create task (also creates worktree)
	create: oc
		.input(
			z.object({
				repositoryId: z.string(),
				name: z.string().min(1).max(100),
				description: z.string().max(2000).optional(),
				labels: z.array(z.string()).optional(),
				branchName: z.string().optional(),
			}),
		)
		.output(
			z.object({
				task: TaskSchema,
				worktree: WorktreeSchema,
			}),
		),

	// Update task metadata
	update: oc
		.input(
			z.object({
				taskId: z.string(),
				name: z.string().min(1).max(100).optional(),
				description: z.string().max(2000).optional(),
				labels: z.array(z.string()).optional(),
			}),
		)
		.output(TaskSchema),

	// Delete task
	delete: oc
		.input(
			z.object({
				taskId: z.string(),
				deleteWorktree: z.boolean().default(true),
				commitFirst: z.boolean().default(false),
			}),
		)
		.output(z.void()),
};
