import { z } from "zod";
import { defineEvent, TokenUsageSchema, TurnErrorSchema } from "../types/event";
import { AgentRequestSchema } from "../types/request";
import { HarnessAgentIdSchema } from "../types/harness-agent-id";

const sid = { sessionId: z.string() };

// —— session-scoped (per-session stream) ——
export const SessionTurnStarted = defineEvent({
  type: "session.turn.started",
  schema: { ...sid, turnId: z.string() },
});
export const SessionTurnEnded = defineEvent({
  type: "session.turn.ended",
  schema: {
    ...sid,
    turnId: z.string(),
    outcome: z.enum(["completed", "failed", "canceled"]),
    usage: TokenUsageSchema.optional(),
    error: TurnErrorSchema.optional(),
  },
});
export const SessionRequestAsked = defineEvent({
  type: "session.request.asked",
  schema: { ...sid, request: AgentRequestSchema },
});
export const SessionRequestReplied = defineEvent({
  type: "session.request.replied",
  schema: { ...sid, requestId: z.string() },
});
export const SessionRequestRejected = defineEvent({
  type: "session.request.rejected",
  schema: { ...sid, requestId: z.string(), reason: z.string().optional() },
});
export const SessionCrashed = defineEvent({
  type: "session.crashed",
  schema: { ...sid, reason: z.string() },
});

// —— global (session collection + other business modules) ——
export const SessionCreated = defineEvent({
  type: "session.created",
  schema: { sessionId: z.string(), harnessAgentId: HarnessAgentIdSchema },
});
export const SessionUpdated = defineEvent({
  type: "session.updated",
  schema: { sessionId: z.string() },
});
export const SessionDeleted = defineEvent({
  type: "session.deleted",
  schema: { sessionId: z.string() },
});
export const SessionRenamed = defineEvent({
  type: "session.renamed",
  schema: { sessionId: z.string(), name: z.string() },
});
export const ProjectUpdated = defineEvent({
  type: "project.updated",
  schema: { projectId: z.string() },
});
export const PtyCreated = defineEvent({ type: "pty.created", schema: { ptyId: z.string() } });
export const PtyUpdated = defineEvent({ type: "pty.updated", schema: { ptyId: z.string() } });
export const PtyExited = defineEvent({
  type: "pty.exited",
  schema: { ptyId: z.string(), exitCode: z.number().optional() },
});
export const ProviderUpdated = defineEvent({
  type: "provider.updated",
  schema: { providerId: z.string() },
});
export const McpUpdated = defineEvent({ type: "mcp.updated", schema: { serverId: z.string() } });
export const ServerConnected = defineEvent({ type: "server.connected", schema: {} });
export const ServerDisconnected = defineEvent({ type: "server.disconnected", schema: {} });
