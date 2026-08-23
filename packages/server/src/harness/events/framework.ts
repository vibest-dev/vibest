import {
  AgentRequestSchema,
  HarnessAgentIdSchema,
  TokenUsageSchema,
  TurnErrorSchema,
} from "@vibest/contract";
import type { HarnessAgentId } from "@vibest/contract";
import type { UIMessageChunk } from "ai";
import { Schema } from "effect";

/**
 * Harness-internal event vocabulary. The public `@vibest/contract` wire model is
 * a flat tagged union (`SessionScopedEvent` keyed by `SessionRef`); this module
 * keeps the harness's own ergonomic `defineEvent`/`SessionEnvelope` shape, keyed
 * by the agent-native `sessionId`. `HarnessAgentSession` translates these
 * drafts into the wire model at the fan-out boundary (attaching the `SessionRef`
 * and stamping the per-session `seq`).
 */

export interface EventDef<
  T extends string = string,
  S extends Schema.Struct<Schema.Struct.Fields> = Schema.Struct<Schema.Struct.Fields>,
> {
  readonly type: T;
  readonly schema: S;
}

export type EventValue<D extends EventDef> =
  D extends EventDef<infer T, infer S> ? { readonly type: T } & S["Type"] : never;

export function defineEvent<const T extends string, const F extends Schema.Struct.Fields>(def: {
  readonly type: T;
  readonly schema: F;
}): EventDef<T, Schema.Struct<F>> {
  return { type: def.type, schema: Schema.Struct(def.schema) };
}

const sid = { sessionId: Schema.String };

export const SessionTurnStarted = defineEvent({
  type: "session.turn.started",
  schema: { ...sid, turnId: Schema.String },
});
export const SessionTurnEnded = defineEvent({
  type: "session.turn.ended",
  schema: {
    ...sid,
    turnId: Schema.String,
    outcome: Schema.Literals(["completed", "failed", "canceled"]),
    usage: Schema.optionalKey(TokenUsageSchema),
    error: Schema.optionalKey(TurnErrorSchema),
  },
});
export const SessionRequestAsked = defineEvent({
  type: "session.request.asked",
  schema: { ...sid, request: AgentRequestSchema },
});
export const SessionRequestReplied = defineEvent({
  type: "session.request.replied",
  schema: { ...sid, requestId: Schema.String },
});
export const SessionRequestRejected = defineEvent({
  type: "session.request.rejected",
  schema: { ...sid, requestId: Schema.String, reason: Schema.optionalKey(Schema.String) },
});
export const SessionCrashed = defineEvent({
  type: "session.crashed",
  schema: { ...sid, reason: Schema.String },
});
export const SessionCreated = defineEvent({
  type: "session.created",
  schema: { sessionId: Schema.String, harnessAgentId: HarnessAgentIdSchema },
});
export const SessionUpdated = defineEvent({
  type: "session.updated",
  schema: { sessionId: Schema.String },
});
export const SessionDeleted = defineEvent({
  type: "session.deleted",
  schema: { sessionId: Schema.String },
});
export const SessionRenamed = defineEvent({
  type: "session.renamed",
  schema: { sessionId: Schema.String, title: Schema.String },
});
export const ProjectUpdated = defineEvent({
  type: "project.updated",
  schema: { projectId: Schema.String },
});
export const PtyCreated = defineEvent({ type: "pty.created", schema: { ptyId: Schema.String } });
export const PtyUpdated = defineEvent({ type: "pty.updated", schema: { ptyId: Schema.String } });
export const PtyExited = defineEvent({
  type: "pty.exited",
  schema: { ptyId: Schema.String, exitCode: Schema.optionalKey(Schema.Number) },
});
export const ProviderUpdated = defineEvent({
  type: "provider.updated",
  schema: { providerId: Schema.String },
});
export const McpUpdated = defineEvent({
  type: "mcp.updated",
  schema: { serverId: Schema.String },
});
export const ServerConnected = defineEvent({ type: "server.connected", schema: {} });
export const ServerDisconnected = defineEvent({ type: "server.disconnected", schema: {} });

export const SessionEventDefs = [
  SessionTurnStarted,
  SessionTurnEnded,
  SessionRequestAsked,
  SessionRequestReplied,
  SessionRequestRejected,
  SessionCrashed,
] as const;
export type SessionEvent = EventValue<(typeof SessionEventDefs)[number]>;

export const GlobalEventDefs = [
  SessionCreated,
  SessionUpdated,
  SessionDeleted,
  SessionRenamed,
  ProjectUpdated,
  PtyCreated,
  PtyUpdated,
  PtyExited,
  ProviderUpdated,
  McpUpdated,
  ServerConnected,
  ServerDisconnected,
] as const;
export type GlobalEvent = EventValue<(typeof GlobalEventDefs)[number]>;

export type SessionEnvelopeBody = UIMessageChunk | SessionEvent;
export type SessionEnvelope = {
  readonly harnessAgentId: HarnessAgentId;
  readonly sessionId: string;
  readonly seq: number;
  readonly body: SessionEnvelopeBody;
};
export type SessionEnvelopeDraft = Omit<SessionEnvelope, "seq">;

export const isSessionEvent = (body: SessionEnvelopeBody): body is SessionEvent =>
  body.type.includes(".");
