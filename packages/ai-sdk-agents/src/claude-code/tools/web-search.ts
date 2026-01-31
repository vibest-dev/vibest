import { tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

export const WebSearch = tool({
  type: "provider-defined",
  id: "claude-code.WebSearch",
  name: "WebSearch",
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#websearch
  inputSchema: z.object({
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
  }),
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#websearch-2
  outputSchema: z.string(),
});

export type WebSearchUIToolInvocation = UIToolInvocation<typeof WebSearch>;
