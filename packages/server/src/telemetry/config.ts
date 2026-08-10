import type * as LogLevel from "effect/LogLevel";

import { logsDirectory, resolveVibestHome } from "../config/paths";

/**
 * How the human-facing console stream is rendered — or silenced. The daemon
 * runs with `quiet` because its stdout is already redirected into
 * `daemon.log`, and duplicating the structured file there would double every
 * line for no gain.
 */
export type ConsoleFormat = "pretty" | "json" | "quiet";

export type TelemetryConfig = {
  /** `$VIBEST_HOME/logs` — one `server-<local-date>.jsonl` per day. */
  readonly logsDir: string;
  readonly minimumLogLevel: LogLevel.LogLevel;
  readonly consoleFormat: ConsoleFormat;
  /** Log files older than this are removed at startup. */
  readonly retentionDays: number;
};

const LOG_LEVELS: ReadonlyArray<LogLevel.LogLevel> = [
  "All",
  "Fatal",
  "Error",
  "Warn",
  "Info",
  "Debug",
  "Trace",
  "None",
];

const CONSOLE_FORMATS: ReadonlyArray<ConsoleFormat> = ["pretty", "json", "quiet"];

/**
 * Misconfiguration falls back to the default rather than failing. Logging is
 * the thing that would have to report the failure, so a strict parse here
 * could take the server down over a typo in an env var and leave no trace of
 * why.
 */
const parseFrom = <A extends string>(
  allowed: ReadonlyArray<A>,
  raw: string | undefined,
  fallback: A,
): A => {
  if (raw === undefined) return fallback;
  const wanted = raw.trim().toLowerCase();
  return allowed.find((value) => value.toLowerCase() === wanted) ?? fallback;
};

const parseDays = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const days = Number.parseInt(raw, 10);
  return Number.isInteger(days) && days > 0 ? days : fallback;
};

/**
 * Resolve logging configuration from the ambient environment. Pure — an env
 * lookup and some string math perform no effectful work
 * (`.agents/rules/stack.md`, "Where the boundary is"), which is also what lets
 * the precedence be tested without a runtime.
 *
 * The dev/prod split is inherited from `resolveVibestHome`, so
 * `~/.vibest-dev/logs` and `~/.vibest/logs` separate themselves with no
 * additional configuration.
 */
export function resolveTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  return {
    logsDir: logsDirectory(resolveVibestHome(env)),
    minimumLogLevel: parseFrom(LOG_LEVELS, env.VIBEST_LOG_LEVEL, "Info"),
    consoleFormat: parseFrom(CONSOLE_FORMATS, env.VIBEST_LOG_CONSOLE, "pretty"),
    retentionDays: parseDays(env.VIBEST_LOG_RETENTION_DAYS, 30),
  };
}
