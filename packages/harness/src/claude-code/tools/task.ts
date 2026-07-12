import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod";

const inputSchema = z.object({
  /**
   * A short (3-5 word) description of the task
   */
  description: z.string(),
  /**
   * The task for the agent to perform
   */
  prompt: z.string(),
  /**
   * The type of specialized agent to use for this task
   */
  subagent_type: z.string(),
});

const outputSchema = z.union([
  z.string(),
  z.array(
    z.object({
      type: z.literal("text"),
      text: z.string(),
    }),
  ),
]);

export const Task: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.Task",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#task
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#task-2
  outputSchema,
});

export type TaskUIToolInvocation = UIToolInvocation<typeof Task>;
