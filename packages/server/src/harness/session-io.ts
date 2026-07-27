import {
  HarnessAgentIdSchema,
  InspectorTargetSchema,
  PermissionModeSchema,
  ReasoningEffortSchema,
} from "@vibest/contract";
import { Schema } from "effect";

/**
 * Harness-local session I/O types. The contract's SessionRef rewrite removed the
 * agent-native lifecycle inputs (create/resume/prompt keyed by a flat native
 * `sessionId`); the server now owns the `SessionRef` translation and hands the
 * harness these narrow, native-keyed shapes.
 */

export const CreateSessionInputSchema = Schema.Struct({
  cwd: Schema.String,
  sessionId: Schema.optionalKey(Schema.String),
  // Session config chosen at create time, applied via the session's own
  // setters before the first prompt (applyInitialSessionConfig). `model` is
  // the provider-local model id — the server unpacked and validated the
  // providerId/modelId pair before the harness layer ever sees it.
  model: Schema.optionalKey(Schema.String),
  reasoningEffort: Schema.optionalKey(ReasoningEffortSchema),
  // Vibest's own permission vocabulary; membership in this harness's declared
  // subset was checked at the RPC boundary.
  permissionMode: Schema.optionalKey(PermissionModeSchema),
});
export type CreateSessionInput = typeof CreateSessionInputSchema.Type;

export const ResumeSessionInputSchema = Schema.Struct({
  sessionId: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
});
export type ResumeSessionInput = typeof ResumeSessionInputSchema.Type;

export const ResumeManagedSessionInputSchema = Schema.Struct({
  sessionId: Schema.String,
  harnessAgentId: HarnessAgentIdSchema,
  cwd: Schema.optionalKey(Schema.String),
});
export type ResumeManagedSessionInput = typeof ResumeManagedSessionInputSchema.Type;

export const CreateManagedSessionResultSchema = Schema.Struct({
  sessionId: Schema.String,
  harnessAgentId: HarnessAgentIdSchema,
});
export type CreateManagedSessionResult = typeof CreateManagedSessionResultSchema.Type;

export const UserInputPartSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("data-inspector"),
    data: Schema.Array(InspectorTargetSchema),
  }),
]);
export type UserInputPart = typeof UserInputPartSchema.Type;

export const UserInputSchema = Schema.Struct({
  parts: Schema.Array(UserInputPartSchema),
});
export type UserInput = typeof UserInputSchema.Type;

export const PromptReceiptSchema = Schema.Struct({ turnId: Schema.String });
export type PromptReceipt = typeof PromptReceiptSchema.Type;
