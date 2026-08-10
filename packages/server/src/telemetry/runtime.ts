import { Context, Effect, FileSystem, Layer, Logger, References, type Scope } from "effect";

import type { TelemetryConfig } from "./config";
import { installCrashHandler } from "./crash";
import { makeFileLogger } from "./file-sink";
import { jsonl } from "./format";

/** The process-wide telemetry runtime, exposing only what other roots need. */
export type TelemetryRuntime = {
  readonly provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly provideToLayer: <A, E, R>(layer: Layer.Layer<A, E, R>) => Layer.Layer<A, E, R>;
  /** Run a synchronous callback log without allowing telemetry defects to escape. */
  readonly emit: (effect: Effect.Effect<void>) => void;
};

export const telemetryRuntimeFromContext = (context: Context.Context<never>): TelemetryRuntime => ({
  provide: (effect) => effect.pipe(Effect.provide(context)),
  provideToLayer: (layer) => layer.pipe(Layer.provideMerge(Layer.succeedContext(context))),
  emit: (effect) => {
    void Effect.runSyncExitWith(context)(effect);
  },
});

export const defaultTelemetryRuntime = telemetryRuntimeFromContext(Context.empty());

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

/** Build this process's one scoped telemetry runtime. */
export const makeTelemetryRuntime = (
  config: TelemetryConfig,
): Effect.Effect<TelemetryRuntime, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileLogger = yield* makeFileLogger({
      directory: config.logsDir,
      retentionDays: config.retentionDays,
    });
    yield* installCrashHandler(config.logsDir);

    const console = consoleLogger(config);
    const loggers = console === undefined ? [fileLogger] : [console, fileLogger];
    const logging = Layer.mergeAll(
      Logger.layer(loggers),
      Layer.succeed(References.MinimumLogLevel, config.minimumLogLevel),
      Layer.succeed(Logger.LogToStderr, true),
    );

    return telemetryRuntimeFromContext(yield* Layer.build(logging));
  });
