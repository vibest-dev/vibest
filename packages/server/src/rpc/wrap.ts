import { ORPCError } from "@orpc/server";
import { Cause, Context, Crypto, Effect } from "effect";

/**
 * The server's defect boundary — the one place unexpected failures become
 * observable. Everything the routers' translation tables deliberately keep out
 * of the public vocabulary (the `"internal"` decisions) and every defect ends
 * here: logged with a short correlation ref, then replaced on the wire by a
 * generic INTERNAL_SERVER_ERROR carrying only that ref. Structured detail
 * never leaves the process; the ref connects a user report to the daemon log
 * line. Interrupt-only causes (client cancellations) pass through untouched.
 *
 * Installed as oRPC's `effect/wrap`, which runs after the extension's
 * ORPCError handling — a translated protocol error is already a success by
 * the time this sees the effect, so only unexpected causes land in the catch.
 */
export const makeWrapRpcEffect = (services: Context.Context<Crypto.Crypto>) => {
  const crypto = Context.get(services, Crypto.Crypto);
  return <A, E>(
    effect: Effect.Effect<A, E>,
    opts: { readonly path: ReadonlyArray<string> },
  ): Effect.Effect<A, E> =>
    // The wire error replaces the typed channel, so the returned effect no
    // longer matches `E` — oRPC's wrap signature can't express that, hence the
    // cast. Runtime-wise oRPC only ever squashes and throws the failure.
    Effect.catchCause(
      effect,
      (cause): Effect.Effect<never, E | ORPCError<"INTERNAL_SERVER_ERROR", unknown>> =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              const ref = `err_${(yield* crypto.randomUUIDv4.pipe(Effect.orDie)).slice(0, 8)}`;
              yield* Effect.logError("rpc handler failed", cause).pipe(
                Effect.annotateLogs({ ref, procedure: opts.path.join(".") }),
              );
              return yield* Effect.fail(
                new ORPCError("INTERNAL_SERVER_ERROR", {
                  message: `Unexpected server error (ref ${ref}). Check the server logs for details.`,
                }),
              );
            }),
    ) as Effect.Effect<A, E>;
};
