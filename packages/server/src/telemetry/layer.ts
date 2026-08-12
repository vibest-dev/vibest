import { Effect, Layer, Logger, References } from "effect";

import type { TelemetryConfig } from "./config";
import { installCrashHandler } from "./crash";
import { makeFileLogger } from "./file-sink";
import { jsonl } from "./format";

const consoleLogger = (config: TelemetryConfig): Logger.Logger<unknown, void> | undefined => {
  switch (config.consoleFormat) {
    case "quiet":
      return undefined;
    case "pretty":
      return Logger.consolePretty();
    case "json":
      // stdout carries the `vibest:ready` handshake.
      return Logger.withConsoleError(jsonl);
  }
};

/** The process-owned logging layer. Build it once, in the outer server scope. */
export const layer = (config: TelemetryConfig) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const file = yield* makeFileLogger({
        directory: config.logsDir,
        retentionDays: config.retentionDays,
      });
      yield* installCrashHandler(config.logsDir);

      const console = consoleLogger(config);
      const loggers = console === undefined ? [file] : [console, file];
      return yield* Layer.build(
        Layer.mergeAll(
          Logger.layer(loggers, { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, config.minimumLogLevel),
          Layer.succeed(Logger.LogToStderr, true),
        ),
      );
    }),
  );
