import { Cause, Clock, Effect, Exit, type Tracer } from "effect";

/**
 * Trace an application operation and emit one completion record from inside
 * the span, so the normal logger supplies its trace id and causal path.
 */
export const withLoggedSpan =
  (name: string, options?: Tracer.SpanOptions) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const span = yield* Effect.currentSpan.pipe(Effect.orDie);
          const endTime = yield* Clock.currentTimeNanos;
          const outcome = Exit.isSuccess(exit)
            ? "ok"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupted"
              : "error";
          const write = outcome === "error" ? Effect.logWarning : Effect.logDebug;
          yield* write(name).pipe(
            Effect.annotateLogs({
              ...Object.fromEntries(span.attributes),
              event: "span",
              durationMs: Number(endTime - span.status.startTime) / 1_000_000,
              outcome,
            }),
          );
        }).pipe(Effect.catchCause(() => Effect.void)),
      ),
      Effect.withSpan(name, options),
    );
