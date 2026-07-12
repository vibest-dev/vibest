import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

const inputSchema = z.object({
  /**
   * The absolute path to the Jupyter notebook file
   */
  notebook_path: z.string(),
  /**
   * The ID of the cell to edit
   */
  cell_id: z.string().optional(),
  /**
   * The new source for the cell
   */
  new_source: z.string(),
  /**
   * The type of the cell (code or markdown)
   */
  cell_type: z.enum(["code", "markdown"]).optional(),
  /**
   * The type of edit (replace, insert, delete)
   */
  edit_mode: z.enum(["replace", "insert", "delete"]).optional(),
});

const outputSchema = z.string();

export const NotebookEdit: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.NotebookEdit",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#notebookedit
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#notebookedit-2
  outputSchema,
});

export type NotebookEditUIToolInvocation = UIToolInvocation<typeof NotebookEdit>;
