import type { UIMessage } from "ai";

import type { SessionEnvelope } from "./envelope";
import type { HarnessAgentId } from "./harness-agent-id";
import type { AgentRequest } from "./request";

export type SessionStatus = {
  status: "initializing" | "running" | "closed" | "crashed";
  isBusy: boolean;
  needsAttention: boolean;
};

export type SessionSummary = {
  sessionId: string;
  harnessAgentId: HarnessAgentId;
  title?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SessionSnapshot = {
  history: UIMessage[]; // cold: folded from the backend native store
  activeTurn: { chunks: SessionEnvelope[] } | null; // hot: active turn's render chunks
  pendingRequests: AgentRequest[];
  cursor: number; // last seq the client has seen for this session
  bootId: string;
};

export type UserInput = { text: string };
export type CreateSessionConfig = { workspacePath: string }; // model decided by the adapter
export type AvailabilityResult = { available: boolean; reason?: string };

/** Read-only view the adapter session hands to `toSessionEvent` for turn synthesis. */
export interface LifecycleView {
  readonly sessionId: string;
  readonly activeTurnId: string | undefined; // undefined = no turn in flight
  nextTurnId(): string;
}
