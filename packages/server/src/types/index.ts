/**
 * Core domain types for the harness agent runtime.
 *
 * These are the plain data shapes shared across modules. Effect services
 * (Context.Service + Layer) live in each module; DTOs like these stay plain.
 */

/** Identifies an agent backend adapter. */
export type HarnessAgentId = "claude-code" | "codex" | "pi";

export const HARNESS_AGENT_IDS: ReadonlyArray<HarnessAgentId> = ["claude-code", "codex", "pi"];

export const isHarnessAgentId = (value: string): value is HarnessAgentId =>
  (HARNESS_AGENT_IDS as ReadonlyArray<string>).includes(value);

/** A project is a workspace path the runtime can open sessions against. */
export type { Project } from "@vibest/contract";

/**
 * Server-owned recovery record for one session, persisted at
 * `storage/sessions/<projectId>/<sessionId>.json`. The filename mirrors
 * `sessionId`, which is also stored in the body so a loaded record is
 * self-contained; `harnessSessionId` is the agent-native id (claude session
 * uuid / codex thread id) the server translates to when calling the harness.
 *
 * Display data is self-owned — `list` reads this record and never queries the
 * backend session index. Identity + `cwd` + `createdAt` are written at create;
 * `title` is set from the first prompt. `updatedAt` / `historyAvailable` are
 * reserved: the harness is the only source for a refined title, real recency,
 * transcript existence, or an imported session, so they stay unwritten until we
 * reintroduce an on-demand reconcile for those.
 * See docs/adr/0002-session-info-storage-floor-harness-overlay.md.
 */
export interface Session {
  readonly version: 1;
  readonly sessionId: string;
  readonly projectId: string;
  readonly harnessAgentId: HarnessAgentId;
  readonly harnessSessionId: string;
  readonly createdAt: string;
  /**
   * Working directory. Our input at `create` (currently the project path).
   * Optional for legacy records; callers fall back to the project path.
   */
  readonly cwd?: string;
  /** Display title, set from the session's first prompt. */
  readonly title?: string;
  /** Recency (ISO). Reserved — not written yet (see the type doc). */
  readonly updatedAt?: string;
  /** Whether the backend still has the transcript. Reserved — not written yet. */
  readonly historyAvailable?: boolean;
}
