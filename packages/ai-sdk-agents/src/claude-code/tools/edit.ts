import { tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

export const Edit = tool({
  type: "provider-defined",
  id: "claude-code.Edit",
  name: "Edit",
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#edit
  inputSchema: z.object({
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
  }),
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#edit-2
  outputSchema: z.string(),
});

export type EditUIToolInvocation = UIToolInvocation<typeof Edit>;
