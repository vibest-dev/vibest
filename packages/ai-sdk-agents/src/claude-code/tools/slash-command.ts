import { tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

export const SlashCommand = tool({
  type: "provider-defined",
  id: "claude-code.SlashCommand",
  name: "SlashCommand",
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/slash-commands
  inputSchema: z.object({
    /**
     * The slash command to execute, including the leading /
     */
    command: z.string(),
  }),
  // Docs: https://docs.claude.com/en/docs/claude-code/slash-commands
  outputSchema: z.string(),
});

export type SlashCommandUIToolInvocation = UIToolInvocation<typeof SlashCommand>;
