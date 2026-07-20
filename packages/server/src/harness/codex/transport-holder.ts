import { Cause, Deferred, Effect, Exit, Scope, SynchronizedRef } from "effect";

import { CodexTransportError } from "../errors";
import type { CodexTransport } from "./transport";

export type ManagedCodexTransport = {
  readonly generation: number;
  readonly transport: CodexTransport;
  readonly scope: Scope.Closeable;
};

type TransportState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<ManagedCodexTransport, CodexTransportError>;
    }
  | { readonly _tag: "Running"; readonly value: ManagedCodexTransport };

type EnsureDecision =
  | {
      readonly _tag: "Start" | "Wait";
      readonly deferred: Deferred.Deferred<ManagedCodexTransport, CodexTransportError>;
    }
  | { readonly _tag: "Ready"; readonly value: ManagedCodexTransport };

export interface CodexTransportHolder {
  readonly ensure: Effect.Effect<CodexTransport, CodexTransportError>;
  /** Returns the installed transport without triggering startup or restart. */
  readonly current: Effect.Effect<CodexTransport | undefined>;
  readonly status: Effect.Effect<TransportState["_tag"]>;
}

export interface CodexTransportHolderOptions<R> {
  readonly makeTransport: () => Effect.Effect<CodexTransport, CodexTransportError, R | Scope.Scope>;
}

const shutdownError = () =>
  new CodexTransportError({
    operation: "transport-holder-shutdown",
    cause: new Error("Codex transport holder scope closed"),
  });

const buildError = (cause: Cause.Cause<CodexTransportError>) => {
  const error = Cause.squash(cause);
  return error instanceof CodexTransportError
    ? error
    : new CodexTransportError({ operation: "transport-build", cause: error });
};

export const makeCodexTransportHolder = <R>(
  options: CodexTransportHolderOptions<R>,
): Effect.Effect<CodexTransportHolder, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const buildContext = yield* Effect.context<R>();
    const state = yield* SynchronizedRef.make<TransportState>({ _tag: "Idle" });
    const nextGeneration = yield* SynchronizedRef.make(1);

    const release = (managed: ManagedCodexTransport) =>
      SynchronizedRef.modify(state, (current) => {
        if (current._tag !== "Running" || current.value.generation !== managed.generation) {
          return [false, current] as const;
        }
        return [true, { _tag: "Idle" } as const] as const;
      }).pipe(
        Effect.flatMap((released) =>
          released ? Scope.close(managed.scope, Exit.void).pipe(Effect.asVoid) : Effect.void,
        ),
      );

    const watchTermination = (managed: ManagedCodexTransport): Effect.Effect<void> =>
      managed.transport.awaitTermination.pipe(Effect.catch(() => release(managed)));

    const failBuild = (
      deferred: Deferred.Deferred<ManagedCodexTransport, CodexTransportError>,
      error: CodexTransportError,
      childScope: Scope.Closeable,
    ) =>
      Scope.close(childScope, Exit.fail(error)).pipe(
        Effect.andThen(
          SynchronizedRef.modify(state, (current) => {
            if (current._tag === "Starting" && current.deferred === deferred) {
              return [true, { _tag: "Idle" } as const] as const;
            }
            return [false, current] as const;
          }),
        ),
        Effect.andThen(Deferred.fail(deferred, error)),
        Effect.asVoid,
      );

    const build = (
      deferred: Deferred.Deferred<ManagedCodexTransport, CodexTransportError>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const childScope = yield* Scope.fork(ownerScope, "sequential");
        yield* Effect.gen(function* () {
          const generation = yield* SynchronizedRef.getAndUpdate(
            nextGeneration,
            (current) => current + 1,
          );
          const built = yield* options
            .makeTransport()
            .pipe(
              Effect.provideService(Scope.Scope, childScope),
              Effect.provideContext(buildContext),
              Effect.exit,
            );

          if (Exit.isFailure(built)) {
            yield* failBuild(deferred, buildError(built.cause), childScope);
            return;
          }

          const managed: ManagedCodexTransport = {
            generation,
            transport: built.value,
            scope: childScope,
          };
          const installed = yield* SynchronizedRef.modify(state, (current) => {
            if (current._tag === "Starting" && current.deferred === deferred) {
              return [true, { _tag: "Running", value: managed } as const] as const;
            }
            return [false, current] as const;
          });

          if (!installed) {
            yield* Scope.close(childScope, Exit.void);
            yield* Deferred.fail(deferred, shutdownError());
            return;
          }

          yield* Deferred.succeed(deferred, managed);
          yield* Effect.forkIn(watchTermination(managed), ownerScope);
        }).pipe(
          Effect.catchCause((cause) =>
            failBuild(
              deferred,
              new CodexTransportError({
                operation: "transport-build",
                cause: Cause.squash(cause),
              }),
              childScope,
            ),
          ),
        );
      });

    const ensureTransport = (): Effect.Effect<CodexTransport, CodexTransportError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<ManagedCodexTransport, CodexTransportError>();
          const decision = yield* SynchronizedRef.modify<TransportState, EnsureDecision>(
            state,
            (current) => {
              switch (current._tag) {
                case "Idle":
                  return [
                    { _tag: "Start", deferred: candidate },
                    { _tag: "Starting", deferred: candidate },
                  ];
                case "Starting":
                  return [{ _tag: "Wait", deferred: current.deferred }, current];
                case "Running":
                  return [{ _tag: "Ready", value: current.value }, current];
              }
            },
          );

          if (decision._tag === "Ready") {
            if (yield* decision.value.transport.isTerminated) {
              yield* release(decision.value);
              return yield* restore(Effect.suspend(ensureTransport));
            }
            return decision.value.transport;
          }

          if (decision._tag === "Start") {
            yield* Effect.forkIn(build(decision.deferred), ownerScope);
          }

          const managed = yield* restore(Deferred.await(decision.deferred));
          return managed.transport;
        }),
      );

    const ensure: CodexTransportHolder["ensure"] = Effect.suspend(ensureTransport);

    yield* Effect.addFinalizer(() =>
      SynchronizedRef.getAndSet(state, { _tag: "Idle" }).pipe(
        Effect.flatMap((current) => {
          switch (current._tag) {
            case "Idle":
              return Effect.void;
            case "Starting":
              return Deferred.fail(current.deferred, shutdownError()).pipe(Effect.asVoid);
            case "Running":
              return Scope.close(current.value.scope, Exit.void);
          }
        }),
      ),
    );

    return {
      ensure,
      current: SynchronizedRef.get(state).pipe(
        Effect.map((current) => (current._tag === "Running" ? current.value.transport : undefined)),
      ),
      status: SynchronizedRef.get(state).pipe(Effect.map((current) => current._tag)),
    } satisfies CodexTransportHolder;
  });
