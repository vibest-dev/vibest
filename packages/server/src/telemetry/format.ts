import { Formatter, Logger, Option, Redactable } from "effect";
import type * as Tracer from "effect/Tracer";

/**
 * What one line of `server-<date>.jsonl` holds.
 *
 * Everything above `traceId` is `Logger.formatStructured`'s own output. Note
 * that its `spans` field is NOT tracing spans — it carries
 * `Effect.withLogSpan` labels and their elapsed millis, which is a different
 * mechanism with a confusingly similar name. The tracing correlation is the
 * three fields below it, which `formatStructured` does not provide.
 */
export type LogRecord = {
  readonly level: string;
  readonly fiberId: string;
  readonly timestamp: string;
  readonly message: unknown;
  readonly cause: string | undefined;
  readonly annotations: Record<string, unknown>;
  /**
   * `Effect.withLogSpan` labels → elapsed ms. Not tracing spans.
   *
   * Optional because nothing in this codebase calls `withLogSpan`, so
   * `formatStructured` emits an empty object on every single line. Kept for
   * whoever adds the first one, dropped when empty so it is not a fixed tax on
   * a file that is read with `jq`.
   */
  readonly spans?: Record<string, number>;
  /**
   * Which process wrote the line. A daemon, a foreground `vibest serve`, and a
   * CLI can all share one day's file, and `$VIBEST_DAEMON_DIR` explicitly
   * supports several daemons over one `$VIBEST_HOME`.
   */
  readonly pid: number;
  /** W3C trace id of the enclosing `Effect.withSpan`, when there is one. */
  readonly traceId?: string;
  readonly spanId?: string;
  /** `rpc.session.prompt > session.turn > harness.open` — the causal path. */
  readonly span?: string;
};

// A span chain is a handful deep in practice; the bound only stops a cycle
// from turning one log line into an infinite loop.
const MAX_SPAN_DEPTH = 16;

const parentOf = (span: Tracer.AnySpan): Tracer.AnySpan | undefined =>
  span._tag === "Span" ? Option.getOrUndefined(span.parent) : undefined;

/**
 * `root > … > leaf`. An `ExternalSpan` (a trace continued from elsewhere) has
 * no name, so it contributes nothing but is still walked through.
 */
const spanPath = (leaf: Tracer.AnySpan): string => {
  // Walks leaf-to-root but `unshift`s, so the result reads root-first without a
  // reversal step. `toReversed` is not an option: `@vibest/cli` compiles
  // against a pre-ES2023 lib, and `oxlint --fix` rewrites `reverse()` into it.
  const names: Array<string> = [];
  let current: Tracer.AnySpan | undefined = leaf;
  for (let depth = 0; current !== undefined && depth < MAX_SPAN_DEPTH; depth += 1) {
    if (current._tag === "Span") names.unshift(current.name);
    current = parentOf(current);
  }
  return names.join(" > ");
};

/**
 * `Logger.formatStructured` plus the tracing correlation it omits.
 *
 * `fiber.currentSpan` is free information — it is already on the fiber, so
 * every `Effect.withSpan` in the codebase enriches every log line inside it
 * without a single log statement changing. Sampling does not affect this: an
 * unsampled span is still created and still carries its ids, it is merely not
 * exported.
 */
export const structured: Logger.Logger<unknown, LogRecord> = Logger.make((options) => {
  const { spans, ...rest } = Logger.formatStructured.log(options);
  const base = {
    ...rest,
    ...(Object.keys(spans).length > 0 ? { spans } : {}),
    pid: process.pid,
  };
  const span = options.fiber.currentSpan;
  if (span === undefined) return base;
  return { ...base, traceId: span.traceId, spanId: span.spanId, span: spanPath(span) };
});

const encodeJson = (record: LogRecord): string => {
  const ancestors: Array<object> = [];
  try {
    return (
      JSON.stringify(record, function (_key, value: unknown) {
        const safe = Redactable.redact(value);
        if (typeof safe === "bigint" || typeof safe === "function" || typeof safe === "symbol") {
          return String(safe);
        }
        if (typeof safe !== "object" || safe === null) return safe;
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
        if (ancestors.includes(safe)) return undefined;
        ancestors.push(safe);
        return safe;
      }) ?? Formatter.formatJson({ message: "empty log record" })
    );
  } catch {
    return Formatter.formatJson({
      level: record.level,
      timestamp: record.timestamp,
      message: "log record could not be encoded",
      annotations: { event: "telemetry.encoding_failed" },
      fiberId: record.fiberId,
      pid: record.pid,
    });
  }
};

/** One safely encoded JSON object per line — the on-disk format. */
export const jsonl: Logger.Logger<unknown, string> = Logger.map(structured, encodeJson);
