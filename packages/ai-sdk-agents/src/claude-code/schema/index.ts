import { z } from "zod/v4";

/**
 * Represents a slash command available in Claude Code
 */
export const SlashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string(),
});

/**
 * Represents information about an available model
 */
export const ModelInfoSchema = z.object({
  value: z.string(),
  displayName: z.string(),
  description: z.string(),
});

/**
 * Represents the status of an MCP server
 */
export const McpServerStatusSchema = z.object({
  name: z.string(),
  status: z.enum(["connected", "failed", "needs-auth", "pending"]),
  serverInfo: z
    .object({
      name: z.string(),
      version: z.string(),
    })
    .optional(),
});

/**
 * Represents the permission mode for tool usage in Claude Code
 */
export const PermissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]);

/**
 * Represents the behavior for a permission decision
 */
export const PermissionBehaviorSchema = z.enum(["allow", "deny", "ask"]);

/**
 * Permission update destination
 */
const PermissionUpdateDestinationSchema = z.enum([
  "userSettings",
  "projectSettings",
  "localSettings",
  "session",
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
    updatedInput: z.record(z.string(), z.unknown()),
    updatedPermissions: z.array(PermissionUpdateSchema).optional(),
  }),
  z.object({
    behavior: z.literal("deny"),
    message: z.string(),
    interrupt: z.boolean().optional(),
  }),
]);
