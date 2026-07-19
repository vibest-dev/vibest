export type { SessionSnapshot, SessionStatus } from "@vibest/contract";

// The session record/summary shape is owned by @vibest/contract
// (`SessionRecord` / `SessionSummary`); no local placeholder here.

export type UserInput = { text: string };
export type CreateSessionConfig = { workspacePath: string };
export type AvailabilityResult = { available: boolean; reason?: string };

export interface LifecycleView {
  readonly sessionId: string;
  readonly activeTurnId: string | undefined;
  nextTurnId(): string;
}
