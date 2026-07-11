import { z } from "zod/v4";

/**
 * Represents a slash command available in Claude Code
 */
export const SlashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string(),
  aliases: z.array(z.string()).optional(),
});

/**
 * Represents information about an available model
 */
export const ModelInfoSchema = z.object({
  value: z.string(),
  resolvedModel: z.string().optional(),
  displayName: z.string(),
  description: z.string(),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(z.enum(["low", "medium", "high", "xhigh", "max"])).optional(),
  supportsAdaptiveThinking: z.boolean().optional(),
  supportsFastMode: z.boolean().optional(),
  supportsAutoMode: z.boolean().optional(),
});

/**
 * Per-tool permission policy for remote MCP servers
 */
const McpServerToolPolicySchema = z.object({
  name: z.string(),
  permission_policy: z.enum(["always_allow", "always_ask", "always_deny"]).optional(),
  org_max_permission: z.enum(["allow", "ask", "blocked"]).optional(),
});

/**
 * MCP server configuration variants (serializable subset reported in status)
 */
const McpStdioServerConfigSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().optional(),
  alwaysLoad: z.boolean().optional(),
});

const McpSSEServerConfigSchema = z.object({
  type: z.literal("sse"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  tools: z.array(McpServerToolPolicySchema).optional(),
  timeout: z.number().optional(),
  alwaysLoad: z.boolean().optional(),
});

const McpHttpServerConfigSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  tools: z.array(McpServerToolPolicySchema).optional(),
  timeout: z.number().optional(),
  alwaysLoad: z.boolean().optional(),
});

const McpSdkServerConfigSchema = z.object({
  type: z.literal("sdk"),
  name: z.string(),
});

const McpClaudeAIProxyServerConfigSchema = z.object({
  type: z.literal("claudeai-proxy"),
  url: z.string(),
  id: z.string(),
  timeout: z.number().optional(),
});

const McpServerStatusConfigSchema = z.union([
  McpStdioServerConfigSchema,
  McpSSEServerConfigSchema,
  McpHttpServerConfigSchema,
  McpSdkServerConfigSchema,
  McpClaudeAIProxyServerConfigSchema,
]);

/**
 * Represents the status of an MCP server
 */
export const McpServerStatusSchema = z.object({
  name: z.string(),
  status: z.enum(["connected", "failed", "needs-auth", "pending", "disabled"]),
  serverInfo: z
    .object({
      name: z.string(),
      version: z.string(),
    })
    .optional(),
  error: z.string().optional(),
  config: McpServerStatusConfigSchema.optional(),
  scope: z.string().optional(),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        annotations: z
          .object({
            readOnly: z.boolean().optional(),
            destructive: z.boolean().optional(),
            openWorld: z.boolean().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

/**
 * Represents the permission mode for tool usage in Claude Code
 */
export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);

/**
 * Represents the behavior for a permission decision
 */
export const PermissionBehaviorSchema = z.enum(["allow", "deny", "ask"]);

/**
 * Classification of how a permission decision was reached
 */
const PermissionDecisionClassificationSchema = z.enum([
  "user_temporary",
  "user_permanent",
  "user_reject",
]);

/**
 * Permission update destination
 */
const PermissionUpdateDestinationSchema = z.enum([
  "userSettings",
  "projectSettings",
  "localSettings",
  "session",
  "cliArg",
]);

/**
 * Permission rule value
 */
const PermissionRuleValueSchema = z.object({
  toolName: z.string(),
  ruleContent: z.string().optional(),
});

/**
 * Permission update object
 */
const PermissionUpdateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("addRules"),
    rules: z.array(PermissionRuleValueSchema),
    behavior: PermissionBehaviorSchema,
    destination: PermissionUpdateDestinationSchema,
  }),
  z.object({
    type: z.literal("replaceRules"),
    rules: z.array(PermissionRuleValueSchema),
    behavior: PermissionBehaviorSchema,
    destination: PermissionUpdateDestinationSchema,
  }),
  z.object({
    type: z.literal("removeRules"),
    rules: z.array(PermissionRuleValueSchema),
    behavior: PermissionBehaviorSchema,
    destination: PermissionUpdateDestinationSchema,
  }),
  z.object({
    type: z.literal("setMode"),
    mode: PermissionModeSchema,
    destination: PermissionUpdateDestinationSchema,
  }),
  z.object({
    type: z.literal("addDirectories"),
    directories: z.array(z.string()),
    destination: PermissionUpdateDestinationSchema,
  }),
  z.object({
    type: z.literal("removeDirectories"),
    directories: z.array(z.string()),
    destination: PermissionUpdateDestinationSchema,
  }),
]);

/**
 * Represents the result of a permission check
 * This is a discriminated union based on the behavior field
 */
export const PermissionResultSchema = z.discriminatedUnion("behavior", [
  z.object({
    behavior: z.literal("allow"),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    updatedPermissions: z.array(PermissionUpdateSchema).optional(),
    toolUseID: z.string().optional(),
    decisionClassification: PermissionDecisionClassificationSchema.optional(),
  }),
  z.object({
    behavior: z.literal("deny"),
    message: z.string(),
    interrupt: z.boolean().optional(),
    toolUseID: z.string().optional(),
    decisionClassification: PermissionDecisionClassificationSchema.optional(),
  }),
]);
