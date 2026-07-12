import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import { InvalidSessionId } from "../errors";
import { type HarnessAgentId, isHarnessAgentId } from "../types";

/**
 * Session ids are encoded as `${harnessAgentId}:${uuid}`. This lets "cold"
 * operations route to the right adapter by splitting the prefix, without a
 * separate routing table or an extra `harnessAgentId` argument (design §5.4).
 */
export const makeSessionId = (harnessAgentId: HarnessAgentId): string =>
  `${harnessAgentId}:${randomUUID()}`;

export interface ParsedSessionId {
  readonly harnessAgentId: HarnessAgentId;
  readonly uuid: string;
}

export const parseSessionId = (
  sessionId: string,
): Effect.Effect<ParsedSessionId, InvalidSessionId> => {
  const idx = sessionId.indexOf(":");
  if (idx <= 0) return Effect.fail(new InvalidSessionId({ sessionId }));
  const prefix = sessionId.slice(0, idx);
  const uuid = sessionId.slice(idx + 1);
  if (!isHarnessAgentId(prefix) || uuid.length === 0) {
    return Effect.fail(new InvalidSessionId({ sessionId }));
  }
  return Effect.succeed({ harnessAgentId: prefix, uuid });
};
