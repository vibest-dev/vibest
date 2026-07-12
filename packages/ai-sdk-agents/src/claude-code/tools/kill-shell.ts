import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod";

const inputSchema = z.object({
  /**
   * The ID of the background shell to kill
   */
  shell_id: z.string(),
});

const outputSchema = z.string();

export const KillShell: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.KillShell",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#killbash
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#killbash-2
  outputSchema,
});

export type KillShellUIToolInvocation = UIToolInvocation<typeof KillShell>;
