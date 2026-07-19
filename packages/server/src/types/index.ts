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

/** Session-related placeholder shapes (fields not fully designed yet). */
export interface SessionSummary {
  readonly id: string;
  readonly harnessAgentId: HarnessAgentId;
  readonly name?: string;
  readonly archived: boolean;
}

/** A session event pushed over the event stream (payload shape is a placeholder). */
export interface SessionEvent {
  readonly sessionId: string;
  readonly harnessAgentId: HarnessAgentId;
  readonly type: string;
  readonly payload: unknown;
}
