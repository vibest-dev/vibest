import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

import {
	BranchSchema,
	DiffResultSchema,
	DiffStatsSchema,
	FileDiffContentSchema,
	GitStatusSchema,
} from "../types";

// Git change event for subscription
export const GitChangeEventSchema = z.object({
	type: z.literal("diff"),
	path: z.string(),
	stats: z.object({
		insertions: z.number(),
		deletions: z.number(),
		filesChanged: z.number(),
	}),
});

export type GitChangeEvent = z.infer<typeof GitChangeEventSchema>;

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

	// Lightweight diff stats (no file content)
	diffStats: oc
		.input(
			z.object({
				path: z.string(),
			}),
		)
		.output(DiffStatsSchema),

	// Single file diff content (lazy loaded)
	fileDiff: oc
		.input(
			z.object({
				path: z.string(),
				filePath: z.string(),
				staged: z.boolean().optional(),
			}),
		)
		.output(FileDiffContentSchema),

	// Subscribe to git changes for a worktree path
	watchChanges: oc
		.input(
			z.object({
				path: z.string(),
			}),
		)
		.output(eventIterator(GitChangeEventSchema)),
};
