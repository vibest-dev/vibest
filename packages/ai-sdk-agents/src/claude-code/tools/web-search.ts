import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod";

const inputSchema = z.object({
  /**
   * The search query to use
   */
  query: z.string(),
  /**
   * Only include results from these domains
   */
  allowed_domains: z.array(z.string()).optional(),
  /**
   * Never include results from these domains
   */
  blocked_domains: z.array(z.string()).optional(),
});

const outputSchema = z.string();

export const WebSearch: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.WebSearch",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#websearch
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#websearch-2
  outputSchema,
});

export type WebSearchUIToolInvocation = UIToolInvocation<typeof WebSearch>;
