import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

const inputSchema = z.object({
  /**
   * The command to execute
   */
  command: z.string(),
  /**
   * Optional timeout in milliseconds (max 600000)
   */
  timeout: z.number().optional(),
  /**
   * Clear, concise description of what this command does in 5-10 words
   */
  description: z.string().optional(),
  /**
   * Set to true to run this command in the background
   */
  run_in_background: z.boolean().optional(),
});

const outputSchema = z.string();

export const Bash: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.Bash",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#bash
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#bash-2
  // TODO real output is content string, but doc define is object
  outputSchema,
});

export type BashUIToolInvocation = UIToolInvocation<typeof Bash>;
