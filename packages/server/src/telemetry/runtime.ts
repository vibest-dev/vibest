import { Context, Effect, FileSystem, Layer, Logger, References, type Scope } from "effect";

import type { TelemetryConfig } from "./config";
import { installCrashHandler } from "./crash";
import { makeFileLogger } from "./file-sink";
import { jsonl } from "./format";

const consoleLogger = (config: TelemetryConfig): Logger.Logger<unknown, void> | undefined => {
  switch (config.consoleFormat) {
    case "quiet":
      return undefined;
    // Reads `LogToStderr` itself, so it lands on stderr like the rest.
    case "pretty":
      return Logger.consolePretty();
    // `withConsoleError` rather than `withConsoleLog`: stdout carries the
    // `vibest:ready` handshake the desktop supervisor parses, and structured
    // logs must not share that channel.
    case "json":
      return Logger.withConsoleError(jsonl);
  }
};

/**
 * Build this process's logging context — once.
 *
 * `CurrentLoggers` (and later `Tracer.Tracer`) are per-context references, not
 * process globals, so every independently-created runtime must be handed this
 * same `Context` or the work it runs logs into the void. There are three such
 * runtimes inside one daemon process alone (`http/main.ts`'s `runMain`,
 * `rpc/handlers.ts`'s `ManagedRuntime`, and the bare `Effect.runPromise` calls
 * in `http/server.ts`), which is why this returns a `Context` to pass down
 * rather than a `Layer` for each of them to build: a second build would mean a
 * second set of loggers writing the same file.
 *
 * Scoped — the file sink's batch fiber and its final flush live in the scope,
 * so the caller must keep it open for the life of the process.
 */
export const makeTelemetryContext = (
  config: TelemetryConfig,
): Effect.Effect<Context.Context<never>, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileLogger = yield* makeFileLogger({
      directory: config.logsDir,
      retentionDays: config.retentionDays,
    });
    // So a crash is a line in the log rather than the log simply stopping.
    yield* installCrashHandler(config.logsDir);
    const console = consoleLogger(config);
    const loggers = console === undefined ? [fileLogger] : [console, fileLogger];

    return yield* Layer.build(
      Layer.mergeAll(
        // Not `mergeWithExisting` — the default logger would otherwise print
        // every line a second time, unstructured.
        Logger.layer(loggers),
        Layer.succeed(References.MinimumLogLevel, config.minimumLogLevel),
        // Effect 4 defaults this to `false`, i.e. the built-in loggers write to
        // stdout. That channel belongs to the `vibest:ready` handshake.
        Layer.succeed(Logger.LogToStderr, true),
      ),
    );
  });
