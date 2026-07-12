import { tool, type Tool, type UIToolInvocation } from "ai";
import { z } from "zod/v4";

const inputSchema = z.object({
  /**
   * The regular expression pattern to search for
   */
  pattern: z.string(),
  /**
   * File or directory to search in (defaults to cwd)
   */
  path: z.string().optional(),
  /**
   * Glob pattern to filter files (e.g. "*.js")
   */
  glob: z.string().optional(),
  /**
   * File type to search (e.g. "js", "py", "rust")
   */
  type: z.string().optional(),
  /**
   * Output mode: "content", "files_with_matches", or "count"
   */
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
  /**
   * Case insensitive search
   */
  "-i": z.boolean().optional(),
  /**
   * Show line numbers (for content mode)
   */
  "-n": z.boolean().optional(),
  /**
   * Lines to show after each match
   */
  "-A": z.number().optional(),
  /**
   * Lines to show before each match
   */
  "-B": z.number().optional(),
  /**
   * Lines to show before and after each match
   */
  "-C": z.number().optional(),
  /**
   * Limit output to first N lines/entries
   */
  head_limit: z.number().optional(),
  /**
   * Enable multiline mode
   */
  multiline: z.boolean().optional(),
});

const outputSchema = z.string();

export const Grep: Tool<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = tool({
  type: "provider",
  id: "claude-code.Grep",
  isProviderExecuted: true,
  args: {},
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#grep
  inputSchema,
  // Docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript#grep-2
  outputSchema,
});

export type GrepUIToolInvocation = UIToolInvocation<typeof Grep>;
