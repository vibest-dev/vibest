import { z } from "zod";

import { HarnessAgentIdSchema } from "./harness-agent-id";

export const AgentRequestActionSchema = z.object({
  id: z.string(),
  label: z.string(),
});
export type AgentRequestAction = z.infer<typeof AgentRequestActionSchema>;

export const AgentRequestQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
});
export type AgentRequestQuestion = z.infer<typeof AgentRequestQuestionSchema>;

export const AgentRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool"),
    id: z.string(),
    harnessAgentId: HarnessAgentIdSchema,
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
    actions: z.array(AgentRequestActionSchema),
    native: z.unknown(),
  }),
  z.object({
    type: z.literal("question"),
    id: z.string(),
    harnessAgentId: HarnessAgentIdSchema,
    questions: z.array(AgentRequestQuestionSchema),
    native: z.unknown(),
  }),
  z.object({
    type: z.literal("plan"),
    id: z.string(),
    harnessAgentId: HarnessAgentIdSchema,
    plan: z.string(),
    native: z.unknown(),
  }),
]);
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export const AgentResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool"),
    behavior: z.enum(["allow", "deny"]),
    message: z.string().optional(),
    native: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("question"),
    answers: z.array(
      z.object({
        questionId: z.string(),
        values: z.array(z.string()),
        other: z.string().optional(),
      }),
    ),
  }),
  z.object({
    type: z.literal("plan"),
    behavior: z.enum(["allow", "deny"]),
    native: z.unknown().optional(),
  }),
]);
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
