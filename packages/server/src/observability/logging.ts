import { Effect, FileSystem, Formatter, Logger, type LogLevel } from "effect";

import { LOG_FILE_MODE, LOGS_DIRECTORY_MODE, vibestLogPath } from "../config/paths";

function formatter(id: string) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message];
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) =>
        plain(value) ? flatten(value) : [["message", value] as const],
      ),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ");
  });
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]];
  seen.add(input);
  const entries = Object.entries(input);
  if (entries.length === 0 && prefix) return [[prefix, input]];
  return entries.flatMap(([key, value]) => {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    return plain(value) ? flatten(value, keyPath, seen) : [[keyPath, value] as const];
  });
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function format(input: unknown): string {
  const value = typeof input === "string" ? input : Formatter.format(input);
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value);
}

export const ensureLogsDirectory = (
  directory: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(directory, { recursive: true, mode: LOGS_DIRECTORY_MODE });
  }).pipe(
    // A logs directory we cannot create is a defect: the process has nowhere
    // to write, and mapping that into a typed error would force every
    // composition root to handle "the disk refused the log dir".
    Effect.orDie,
  );

function fileLogger(target: string, id: string) {
  // Do not set batchWindow to 0; it causes high idle CPU usage.
  return Logger.toFile(formatter(id), target, { flag: "a", mode: LOG_FILE_MODE });
}

function stderrLogger(id: string) {
  return Logger.make((options) => process.stderr.write(`${formatter(id).log(options)}\n`));
}

export function minimumLogLevel(): LogLevel.LogLevel {
  const value = process.env.VIBEST_LOG_LEVEL?.toUpperCase();
  const levels = {
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>;
  return value && value in levels ? levels[value as keyof typeof levels] : levels.INFO;
}

export function loggers(logsDir: string, id: string) {
  const logger = fileLogger(vibestLogPath(logsDir), id);
  return process.env.VIBEST_PRINT_LOGS === "1" ? [logger, stderrLogger(id)] : [logger];
}
