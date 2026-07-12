import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod";

const inputSchema = z.object({
  /**
   * The slash command to execute, including the leading /
   */
  command: z.string(),
});

const outputSchema = z.string();

export const SlashCommand: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.SlashCommand",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/slash-commands
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/slash-commands
  outputSchema,
});

export type SlashCommandUIToolInvocation = UIToolInvocation<typeof SlashCommand>;
