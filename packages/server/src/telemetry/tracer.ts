import { Cause, Context, Effect, Exit, Layer, Tracer } from "effect";

/**
 * A `Tracer` that writes one log line when a span ends.
 *
 * This exists because a span already knows everything a hand-written
 * "operation finished" line says — its name, its duration, whether it failed,
 * its place in the call chain — and saying it twice means a clock read, an
 * `onExit` and a subtraction at every site that cares. `Effect.withSpan(name,
 * { attributes })` becomes the whole instrumentation, and it is instrumentation
 * the traced code was already carrying for the sake of `traceId`.
 *
 * It **decorates** whatever tracer is in context rather than implementing one:
 * id generation, sampling and parenting stay Effect's. That is also what makes
 * an exporter additive later — dropping `OtlpTracer.layer` underneath sends the
 * same spans to a collector with no change here and none in the traced code.
 *
 * Level, and why it is not per-span: a span is a measurement, and measurements
 * belong at `debug` — `rpc.*` alone is one per call. A span that *failed* is
 * news, so it goes to `warn` and shows at the default floor. Facts worth
 * reading on their own ("a session was created") are events rather than spans
 * and stay ordinary `Effect.log` calls.
 */
const spanLogging = (inner: Tracer.Tracer, loggers: Context.Context<never>): Tracer.Tracer => ({
  ...inner,
  span(options) {
    const span = inner.span.call(inner, options);
    const end = span.end.bind(span);
    const emit = (endTime: bigint, exit: Exit.Exit<unknown, unknown>) => {
      // Interruption is not failure, and conflating them is loud in exactly the
      // wrong place: a session's drain fiber is interrupted every time the
      // session closes normally, and a long-lived span is the most likely one
      // to end this way. Only a real failure earns `warn`.
      const outcome = Exit.isSuccess(exit)
        ? "ok"
        : Cause.hasInterruptsOnly(exit.cause)
          ? "interrupted"
          : "error";
      const write = outcome === "error" ? Effect.logWarning : Effect.logDebug;
      // `runFork` because `end` is a synchronous callback on the fiber closing
      // the span, and that callback cannot suspend. A forked fiber carries no
      // context of its own, so the loggers are provided explicitly — without
      // this the span lines go to Effect's default logger on stdout and never
      // reach the file. It is also why the ids are annotated by hand rather
      // than left to `format.ts` to read off `fiber.currentSpan`.
      Effect.runFork(
        write(span.name).pipe(
          Effect.annotateLogs({
            event: "span",
            durationMs: Number(endTime - options.startTime) / 1_000_000,
            outcome,
            traceId: span.traceId,
            spanId: span.spanId,
            ...Object.fromEntries(span.attributes),
          }),
          Effect.provide(loggers),
        ),
      );
    };
    // A fresh object rather than assigning over `span.end`: depending on the
    // tracer underneath, `end` may be an own closure or live on a prototype,
    // and overwriting is only safe in the first case. `status` and `attributes`
    // stay getters because both are mutated after the span is handed back.
    return {
      ...span,
      get status() {
        return span.status;
      },
      get attributes() {
        return span.attributes;
      },
      end(endTime, exit) {
        end(endTime, exit);
        emit(endTime, exit);
      },
      attribute(key, value) {
        span.attribute(key, value);
      },
      event(name, startTime, attributes) {
        span.event(name, startTime, attributes);
      },
      addLinks(links) {
        span.addLinks(links);
      },
    };
  },
});

/**
 * Wraps the ambient tracer. Reading `Tracer.Tracer` out of context rather than
 * constructing one is what lets a real exporter sit underneath: build this over
 * `OtlpTracer.layer` and the spans are both logged and exported.
 *
 * Must be built *under* the logger layer — it captures the surrounding context
 * to hand to its detached fibers, so a build without the loggers in scope
 * silently produces span lines that go nowhere.
 */
// `Layer<never>`, not `Layer<Tracer.Tracer>`: a `Reference` always resolves, so
// setting one provides nothing new to the type — it replaces a default.
export const SpanLoggerLayer: Layer.Layer<never> = Layer.effect(
  Tracer.Tracer,
  Effect.map(Effect.context<never>(), (context) =>
    // Read off the context rather than `Effect.service`, which would put
    // `Tracer.Tracer` in this layer's own requirements. It is a `Reference`, so
    // `Context.get` answers with Effect's built-in tracer when nothing else has
    // been installed — the ordinary case — and with the exporter's when one has.
    spanLogging(Context.get(context, Tracer.Tracer), context),
  ),
);
