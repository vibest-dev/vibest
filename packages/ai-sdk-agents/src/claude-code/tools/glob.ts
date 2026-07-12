import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

const inputSchema = z.object({
  /**
   * The glob pattern to match files against
   */
  pattern: z.string(),
  /**
   * The directory to search in (defaults to cwd)
   */
  path: z.string().optional(),
});

const outputSchema = z.string();

export const Glob: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.Glob",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#glob
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#glob-2
  outputSchema,
});

export type GlobUIToolInvocation = UIToolInvocation<typeof Glob>;
