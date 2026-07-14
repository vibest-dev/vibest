import * as S from "./events/session";
import type { EventValue } from "./types/event";

/** Session-scoped events (control plane carried on a session envelope). */
export const SessionEventDefs = [
  S.SessionTurnStarted,
  S.SessionTurnEnded,
  S.SessionRequestAsked,
  S.SessionRequestReplied,
  S.SessionRequestRejected,
  S.SessionCrashed,
] as const;
export type SessionEvent = EventValue<(typeof SessionEventDefs)[number]>;

/** Global events (session collection + other business modules). */
export const GlobalEventDefs = [
  S.SessionCreated,
  S.SessionUpdated,
  S.SessionDeleted,
  S.SessionRenamed,
  S.ProjectUpdated,
  S.PtyCreated,
  S.PtyUpdated,
  S.PtyExited,
  S.ProviderUpdated,
  S.McpUpdated,
  S.ServerConnected,
  S.ServerDisconnected,
] as const;
export type GlobalEvent = EventValue<(typeof GlobalEventDefs)[number]>;
