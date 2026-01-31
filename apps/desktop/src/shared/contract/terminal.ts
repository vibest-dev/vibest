import { oc } from "@orpc/contract";
import { z } from "zod";

export const TerminalInfoSchema = z.object({
	id: z.string(),
	worktreeId: z.string(),
	title: z.string(),
});

export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

export const terminalContract = {
	create: oc
		.input(
			z.object({
				worktreeId: z.string(),
				cwd: z.string(),
			}),
		)
		.output(TerminalInfoSchema),

	list: oc
		.input(
			z.object({
				worktreeId: z.string(),
			}),
		)
		.output(z.array(TerminalInfoSchema)),

	write: oc.input(
		z.object({
			terminalId: z.string(),
			data: z.string(),
		}),
	),

	resize: oc.input(
		z.object({
			terminalId: z.string(),
			cols: z.number(),
			rows: z.number(),
		}),
	),

	close: oc.input(
		z.object({
			terminalId: z.string(),
		}),
	),
};
