import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod";

const inputSchema = z.object({
  /**
   * The absolute path to the file to modify
   */
  file_path: z.string(),
  /**
   * Array of edit operations to perform sequentially
   */
  edits: z.array(
    z.object({
      /**
       * The text to replace
       */
      old_string: z.string(),
      /**
       * The text to replace it with
       */
      new_string: z.string(),
      /**
       * Replace all occurrences (default false)
       */
      replace_all: z.boolean().optional(),
    }),
  ),
});

const outputSchema = z.string();

export const MultiEdit: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.MultiEdit",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#multiedit
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#multiedit-2
  outputSchema,
});

export type MultiEditUIToolInvocation = UIToolInvocation<typeof MultiEdit>;
