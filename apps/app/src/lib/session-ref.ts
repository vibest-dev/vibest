import type { SessionRef } from "@vibest/contract";

/** Stable client-side key for the complete session identity. */
export const sessionRefKey = (ref: SessionRef): string =>
  JSON.stringify([ref.projectId, ref.harnessAgentId, ref.sessionId]);

/** Compare all identity fields; a bare sessionId is never sufficient. */
export const sameSessionRef = (left: SessionRef, right: SessionRef | null | undefined): boolean =>
  right !== null &&
  right !== undefined &&
  left.projectId === right.projectId &&
  left.harnessAgentId === right.harnessAgentId &&
  left.sessionId === right.sessionId;
