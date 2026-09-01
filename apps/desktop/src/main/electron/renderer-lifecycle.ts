import { Cause, Effect, Exit, Scope, Semaphore } from "effect";
import type { WebContents } from "electron";

export type ConnectRenderer = (
  webContents: WebContents,
) => Effect.Effect<void, unknown, Scope.Scope>;

export interface RendererLifecycle {
  /** Detach the current peer (awaiting its cleanup), then attach a new one. */
  readonly replace: (webContents: WebContents) => Effect.Effect<void>;
  /** Detach the current peer and await its cleanup. */
  readonly detach: Effect.Effect<void>;
  /** Detach the current peer and refuse any later attachment. */
  readonly shutdown: Effect.Effect<void>;
}

// Every transition holds the same permit, so reload, window close, and
// runtime disposal can never clean up the same peer concurrently, and a
// replacement peer is never attached before the previous peer's detach
// resolves. Each attached peer owns a child Scope; closing it awaits the
// peer's finalizers, including the oRPC detach promise.
export function makeRendererLifecycle(connect: ConnectRenderer): Effect.Effect<RendererLifecycle> {
  return Effect.gen(function* () {
    const transitions = yield* Semaphore.make(1);
    let current: Scope.Closeable | undefined;
    let shutDown = false;

    const close = (scope: Scope.Closeable) =>
      Scope.close(scope, Exit.void).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to detach the renderer RPC peer", cause),
        ),
      );

    const detachCurrent = Effect.suspend(() => {
      const scope = current;
      current = undefined;
      return scope ? close(scope) : Effect.void;
    });

    const attach = (webContents: WebContents) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const attached = yield* connect(webContents).pipe(Scope.provide(scope), Effect.exit);
        if (Exit.isSuccess(attached)) {
          current = scope;
          return;
        }
        yield* close(scope);
        if (!Cause.hasInterruptsOnly(attached.cause)) {
          yield* Effect.logError("Failed to connect the renderer RPC peer", attached.cause);
        }
      });

    return {
      replace: (webContents) =>
        transitions.withPermit(
          Effect.gen(function* () {
            yield* detachCurrent;
            if (shutDown) return;
            yield* attach(webContents);
          }),
        ),
      detach: transitions.withPermit(detachCurrent),
      shutdown: transitions.withPermit(
        Effect.suspend(() => {
          shutDown = true;
          return detachCurrent;
        }),
      ),
    } satisfies RendererLifecycle;
  });
}
