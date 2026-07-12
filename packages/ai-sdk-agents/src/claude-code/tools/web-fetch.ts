import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

const inputSchema = z.object({
  /**
   * The URL to fetch content from
   */
  url: z.string(),
  /**
   * The prompt to run on the fetched content
   */
  prompt: z.string(),
});

const outputSchema = z.string();

export const WebFetch: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.WebFetch",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#webfetch
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#webfetch-2
  outputSchema,
});

export type WebFetchUIToolInvocation = UIToolInvocation<typeof WebFetch>;
