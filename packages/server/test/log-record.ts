import { Logger } from "effect";

export type LogRecord = {
  readonly level: string;
  readonly fiberId: string;
  readonly timestamp: string;
  readonly message: unknown;
  readonly cause: string | undefined;
  readonly annotations: Record<string, unknown>;
  readonly spans: Record<string, number>;
};

export const structured: Logger.Logger<unknown, LogRecord> = Logger.formatStructured;
