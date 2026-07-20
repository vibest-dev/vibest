export type SessionSummary = {
  sessionId: string;
  harnessAgentId: import("@vibest/contract").HarnessAgentId;
  title?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UserInput = { text: string };
export type CreateSessionConfig = { workspacePath: string };
export type AvailabilityResult = { available: boolean; reason?: string };

export interface LifecycleView {
  readonly sessionId: string;
  readonly activeTurnId: string | undefined;
  nextTurnId(): string;
}
