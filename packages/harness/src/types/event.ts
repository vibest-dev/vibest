import { z } from "zod";

/** A control-plane event definition: a dotted `type` + a zod object schema for its properties. */
export interface EventDef<T extends string = string, S extends z.ZodRawShape = z.ZodRawShape> {
  readonly type: T;
  readonly schema: z.ZodObject<S>;
}

/** The wire value of an event: a flat tagged object (same shape family as a UIMessageChunk). */
export type EventValue<D extends EventDef> =
  D extends EventDef<infer T, infer S> ? { type: T } & z.infer<z.ZodObject<S>> : never;

export function defineEvent<const T extends string, S extends z.ZodRawShape>(def: {
  type: T;
  schema: S;
}): EventDef<T, S> {
  return { type: def.type, schema: z.object(def.schema) };
}

export const TokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const TurnErrorCategorySchema = z.enum([
  "auth_expired",
  "rate_limited",
  "context_overflow",
  "model_unavailable",
  "network",
  "cancelled",
  "unknown",
]);
export type TurnErrorCategory = z.infer<typeof TurnErrorCategorySchema>;

export const TurnErrorSchema = z.object({
  message: z.string(),
  category: TurnErrorCategorySchema,
  retryAfterMs: z.number().optional(),
});
export type TurnError = z.infer<typeof TurnErrorSchema>;
