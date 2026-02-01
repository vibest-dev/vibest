import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

export const TerminalInfoSchema = z.object({
	id: z.string(),
	worktreeId: z.string(),
});

export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

// Terminal event types for streaming
export const TerminalDataEventSchema = z.object({
	type: z.literal("data"),
	data: z.string(),
});

export const TerminalExitEventSchema = z.object({
	type: z.literal("exit"),
	exitCode: z.number(),
});

export const TerminalEventSchema = z.discriminatedUnion("type", [
	TerminalDataEventSchema,
	TerminalExitEventSchema,
]);

export type TerminalEvent = z.infer<typeof TerminalEventSchema>;

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

	// Subscribe to terminal output stream
	subscribe: oc
		.input(
			z.object({
				terminalId: z.string(),
			}),
		)
		.output(eventIterator(TerminalEventSchema)),
};
