import { tool, type Tool } from "ai";
import { z } from "zod/v4";

const inputSchema = z.object({
  /**
   * The MCP server name
   */
  server: z.string(),
  /**
   * The resource URI to read
   */
  uri: z.string(),
});

const outputSchema = z.object({
  /**
   * Resource contents
   */
  contents: z.array(
    z.object({
      uri: z.string(),
      mimeType: z.string().optional(),
      text: z.string().optional(),
      blob: z.string().optional(),
    }),
  ),
  /**
   * Server that provided the resource
   */
  server: z.string(),
});

export const ReadMcpResource: Tool<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = tool({
  type: "provider",
  id: "claude-code.ReadMcpResource",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#readmcpresource
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#readmcpresource-2
  outputSchema,
});
