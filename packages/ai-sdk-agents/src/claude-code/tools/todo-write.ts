import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

const inputSchema = z.object({
  /**
   * The updated todo list
   */
  todos: z.array(
    z.object({
      /**
       * The task description
       */
      content: z.string(),
      /**
       * The task status
       */
      status: z.enum(["pending", "in_progress", "completed"]),
      /**
       * Active form of the task description
       */
      activeForm: z.string(),
    }),
  ),
});

const outputSchema = z.string();

export const TodoWrite: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.TodoWrite",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#todowrite
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#todowrite-2
  outputSchema,
});

export type TodoWriteUIToolInvocation = UIToolInvocation<typeof TodoWrite>;
