import { tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

export const Read = tool({
  type: "provider-defined",
  id: "claude-code.Read",
  name: "Read",
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#read
  inputSchema: z.object({
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
  }),
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#read-2
  outputSchema: z.string(),
});

export type ReadUIToolInvocation = UIToolInvocation<typeof Read>;
