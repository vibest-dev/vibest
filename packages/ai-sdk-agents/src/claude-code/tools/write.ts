import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

const inputSchema = z.object({
  /**
   * The absolute path to the file to write
   */
  file_path: z.string(),
  /**
   * The content to write to the file
   */
  content: z.string(),
});

const outputSchema = z.string();

export const Write: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.Write",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#write
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#write-2
  outputSchema,
});

export type WriteUIToolInvocation = UIToolInvocation<typeof Write>;
