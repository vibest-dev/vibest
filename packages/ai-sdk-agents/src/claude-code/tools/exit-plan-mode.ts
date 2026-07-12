import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod";

const inputSchema = z.object({
  /**
   * The plan to run by the user for approval
   */
  plan: z.string(),
});

const outputSchema = z.string();

export const ExitPlanMode: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.ExitPlanMode",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#exitplanmode
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#exitplanmode-2
  outputSchema,
});

export type ExitPlanModeUIToolInvocation = UIToolInvocation<typeof ExitPlanMode>;
