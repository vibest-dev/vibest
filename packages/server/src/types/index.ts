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
 * A configured provider — either a built-in whose credentials the user filled
 * in, or a fully custom OpenAI-compatible endpoint.
 */
export interface ProviderConfig {
  readonly id: string;
  readonly name?: string;
  /** Absent for built-ins that already know their endpoint. */
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly enabled: boolean;
  readonly models?: ReadonlyArray<ModelInfo>;
}

export interface ModelInfo {
  readonly id: string;
  readonly name?: string;
}

/** MCP server config — stdio (spawned) or remote (url). */
export type McpServerConfig = McpStdioConfig | McpRemoteConfig;

export interface McpStdioConfig {
  readonly id: string;
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly enabledFor?: ReadonlyArray<HarnessAgentId>;
}

export interface McpRemoteConfig {
  readonly id: string;
  readonly transport: "remote";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly enabledFor?: ReadonlyArray<HarnessAgentId>;
}

/** Shape of `$VIBEST_HOME/config.json`. */
export interface RuntimeConfig {
  readonly provider?: ReadonlyArray<ProviderConfig>;
  readonly mcp?: ReadonlyArray<McpServerConfig>;
}

/**
 * Server-owned recovery record for one session, persisted at
 * `storage/sessions/<projectId>/<sessionId>.json`. The filename mirrors
 * `sessionId`, which is also stored in the body so a loaded record is
 * self-contained; `harnessSessionId` is the agent-native id (claude session
 * uuid / codex thread id) the server translates to when calling the harness.
 *
 * The record is the durable *floor* for session display data. Identity + `cwd`
 * + `createdAt` are ours, written at create. The display *overlay* (`title`,
 * `updatedAt`, `historyAvailable`) is reconciled from the harness's own session
 * index and persisted back here, so `list` reads this record instead of
 * re-querying every backend on every call. A backend with no session index
 * (pi) never fills the overlay and rides the floor. See
 * docs/adr/0002-session-info-storage-floor-harness-overlay.md.
 */
export interface Session {
  readonly version: 1;
  readonly sessionId: string;
  readonly projectId: string;
  readonly harnessAgentId: HarnessAgentId;
  readonly harnessSessionId: string;
  readonly createdAt: string;
  /**
   * Working directory. Our input at `create` (currently the project path);
   * required to resume a claude session before any `getSessionInfo` is possible.
   * Optional for legacy records written before this field existed — callers fall
   * back to the project path.
   */
  readonly cwd?: string;
  /**
   * Display title, reconciled from the harness index (auto-summary / customTitle,
   * falling back to the first prompt). Persisted so `list` needn't re-query.
   */
  readonly title?: string;
  /** Recency (ISO), reconciled from the harness's last-modified time. */
  readonly updatedAt?: string;
  /**
   * Whether the backend still has this session's transcript. `false` once a
   * reconcile finds it gone (not resumable); absent means never reconciled.
   */
  readonly historyAvailable?: boolean;
}
