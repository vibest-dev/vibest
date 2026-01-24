import { oc, type } from "@orpc/contract";
import type { ToolPermissionRequest } from "@vibest/agents/claude-code";
import type { InferUIMessageChunk, UIMessage } from "ai";
import {
	type ClaudeCodeTools,
	McpServerStatusSchema,
	ModelInfoSchema,
	PermissionResultSchema,
	SlashCommandSchema,
} from "ai-sdk-agents/claude-code";
import { z } from "zod/v4";

export const claudeCodeContract = {
	session: {
		create: oc.output(
			z.object({
				sessionId: z.string(),
			}),
		),
		abort: oc.input(
			z.object({
				sessionId: z.string(),
			}),
		),
		getSupportedCommands: oc
			.input(
				z.object({
					sessionId: z.string(),
				}),
			)
			.output(z.array(SlashCommandSchema)),
		getSupportedModels: oc
			.input(
				z.object({
					sessionId: z.string(),
				}),
			)
			.output(z.array(ModelInfoSchema)),
		getMcpServers: oc
			.input(
				z.object({
					sessionId: z.string(),
				}),
			)
			.output(z.array(McpServerStatusSchema)),
	},
	prompt: oc
		.input(
			type<{
				sessionId: string;
				message: UIMessage;
				model?: string;
			}>(),
		)
		.output(
			type<
				AsyncGenerator<
					InferUIMessageChunk<
						UIMessage<undefined, Record<string, unknown>, ClaudeCodeTools>
					>
				>
			>(),
		),
	requestPermission: oc
		.input(
			z.object({
				sessionId: z.string(),
			}),
		)
		.output(type<AsyncGenerator<ToolPermissionRequest>>()),
	respondPermission: oc
		.input(
			z.object({
				sessionId: z.string(),
				requestId: z.string(),
				result: PermissionResultSchema,
			}),
		)
		.output(z.boolean()),
};
