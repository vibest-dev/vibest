import { tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

export const TodoWrite = tool({
  type: "provider-defined",
  id: "claude-code.TodoWrite",
  name: "TodoWrite",
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#todowrite
  inputSchema: z.object({
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
  }),
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#todowrite-2
  outputSchema: z.string(),
});

export type TodoWriteUIToolInvocation = UIToolInvocation<typeof TodoWrite>;
