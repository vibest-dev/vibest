import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

const inputSchema = z.object({
  /**
   * The absolute path to the file to modify
   */
  file_path: z.string(),
  /**
   * The text to replace
   */
  old_string: z.string(),
  /**
   * The text to replace it with (must be different from old_string)
   */
  new_string: z.string(),
  /**
   * Replace all occurrences of old_string (default false)
   */
  replace_all: z.boolean().optional(),
});

const outputSchema = z.string();

export const Edit: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.Edit",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#edit
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#edit-2
  outputSchema,
});

export type EditUIToolInvocation = UIToolInvocation<typeof Edit>;
