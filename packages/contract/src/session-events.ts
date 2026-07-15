import type { SessionEnvelopeBody, SessionEvent } from "./domain";

export const isSessionEvent = (body: SessionEnvelopeBody): body is SessionEvent =>
  body.type.includes(".");
