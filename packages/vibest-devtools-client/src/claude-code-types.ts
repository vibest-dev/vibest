import type { UIMessage } from "ai";
import type { ClaudeCodeTools } from "ai-sdk-agents/claude-code";

export type ClaudeCodeUIInspectorData = {
	file?: string;
	line?: number;
	column?: number;
	component?: string;
};

export type ClaudeCodeUIDataTypes = {
	inspector: ClaudeCodeUIInspectorData[];
};

export type ClaudeCodeUIMessage = UIMessage<
	undefined,
	ClaudeCodeUIDataTypes,
	ClaudeCodeTools
>;
