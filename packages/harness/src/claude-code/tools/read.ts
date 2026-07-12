import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod";

const inputSchema = z.object({
  /**
   * The absolute path to the file to read
   */
  file_path: z.string(),
  /**
   * The line number to start reading from
   */
  offset: z.number().optional(),
  /**
   * The number of lines to read
   */
  limit: z.number().optional(),
});

const outputSchema = z.string();

export const Read: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.Read",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#read
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#read-2
  outputSchema,
});

export type ReadUIToolInvocation = UIToolInvocation<typeof Read>;
