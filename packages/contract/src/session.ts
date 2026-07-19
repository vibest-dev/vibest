import { eventIterator, oc, type } from "@orpc/contract";
import { Schema } from "effect";

import {
  CreateManagedSessionInputSchema,
  CreateManagedSessionResultSchema,
  ListSessionsInputSchema,
  PromptReceiptSchema,
  PromptSessionInputSchema,
  RespondToAgentRequestInputSchema,
  ResumeManagedSessionInputSchema,
  SessionCapabilitiesSchema,
  SessionEventsInputSchema,
  SessionIdInputSchema,
  SessionSummarySchema,
  toStandardSchema,
  type SessionEnvelope,
  type SessionSnapshot,
  type SessionStatus,
} from "./domain";

export type SessionEventStreamItem =
  | { readonly type: "event"; readonly event: SessionEnvelope }
  | { readonly type: "gap"; readonly cursor: number; readonly terminal: boolean };

export const sessionContract = {
  /** vibest's persisted sessions for a project, merged with live backend display data. */
  list: oc
    .input(toStandardSchema(ListSessionsInputSchema))
    .output(toStandardSchema(Schema.Array(SessionSummarySchema))),
  create: oc
    .input(toStandardSchema(CreateManagedSessionInputSchema))
    .output(toStandardSchema(CreateManagedSessionResultSchema)),
  resume: oc.input(toStandardSchema(ResumeManagedSessionInputSchema)),
  prompt: oc
    .input(toStandardSchema(PromptSessionInputSchema))
    .output(toStandardSchema(PromptReceiptSchema)),
  interrupt: oc.input(toStandardSchema(SessionIdInputSchema)),
  close: oc.input(toStandardSchema(SessionIdInputSchema)),
  events: oc
    .input(toStandardSchema(SessionEventsInputSchema))
    .output(eventIterator(type<SessionEventStreamItem>())),
  snapshot: oc.input(toStandardSchema(SessionIdInputSchema)).output(type<SessionSnapshot>()),
  status: oc.input(toStandardSchema(SessionIdInputSchema)).output(type<SessionStatus>()),
  capabilities: oc
    .input(toStandardSchema(SessionIdInputSchema))
    .output(toStandardSchema(SessionCapabilitiesSchema)),
  respondToAgentRequest: oc.input(toStandardSchema(RespondToAgentRequestInputSchema)),
};
