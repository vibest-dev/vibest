import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

const inputSchema = z.object({
  /**
   * The ID of the background shell to retrieve output from
   */
  bash_id: z.string(),
  /**
   * Optional regex to filter output lines
   */
  filter: z.string().optional(),
});

const outputSchema = z.string();

export const BashOutput: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.BashOutput",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#bashoutput
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#bashoutput-2
  outputSchema,
});

export type BashOutputUIToolInvocation = UIToolInvocation<typeof BashOutput>;
