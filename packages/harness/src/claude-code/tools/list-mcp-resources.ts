import { tool, type Tool } from "ai";
import { z } from "zod";

const inputSchema = z.object({
  /**
   * Optional server name to filter resources by
   */
  server: z.string().optional(),
});

const outputSchema = z.object({
  /**
   * Available resources
   */
  resources: z.array(
    z.object({
      uri: z.string(),
      name: z.string(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
      server: z.string(),
    }),
  ),
  /**
   * Total number of resources
   */
  total: z.number(),
});

export const ListMcpResources: Tool<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = tool({
  type: "provider",
  id: "claude-code.ListMcpResources",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#listmcpresources
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#listmcpresources-2
  outputSchema,
});
