import type { ServerNotification, ServerRequest } from "@vibest/contract/codex/protocol";
import { Deferred, type Duration, Effect, Queue, Ref, Schema, Stream, type Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  AgentProcessExited,
  AgentProtocolError,
  CodexRpcError,
  CodexTransportError,
} from "../errors";

const DEFAULT_QUEUE_CAPACITY = 256;
const DEFAULT_FORCE_KILL_AFTER = "2 seconds";

const RpcErrorBody = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
});

const RpcFrame = Schema.Union([
  Schema.Struct({ id: Schema.Number, result: Schema.Unknown }),
  Schema.Struct({ id: Schema.Number, error: RpcErrorBody }),
  Schema.Struct({
    method: Schema.String,
    id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    params: Schema.optionalKey(Schema.Unknown),
  }),
]);

const isRpcFrame = Schema.is(RpcFrame);

export type CodexTransportFailure =
  | CodexTransportError
  | CodexRpcError
  | AgentProcessExited
  | AgentProtocolError;

export interface CodexTransportOptions {
  readonly executablePath?: string;
  readonly cwd?: string;
  readonly args?: ReadonlyArray<string>;
  readonly queueCapacity?: number;
  readonly forceKillAfter?: Duration.Input;
}

export interface CodexTransport {
  readonly request: <A>(
    method: string,
    params?: unknown,
  ) => Effect.Effect<A, CodexTransportFailure>;
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void, CodexTransportError>;
  /** Single-consumer stream owned by the adapter/facade event router. */
  readonly notifications: Stream.Stream<ServerNotification, CodexTransportFailure>;
  /** Single-consumer stream owned by the adapter/facade request router. */
  readonly serverRequests: Stream.Stream<ServerRequest, CodexTransportFailure>;
  readonly respond: (
    id: string | number,
    result: unknown,
  ) => Effect.Effect<void, CodexTransportError>;
  readonly respondError: (
    id: string | number,
    error: { readonly code: number; readonly message: string; readonly data?: unknown },
  ) => Effect.Effect<void, CodexTransportError>;
  readonly isTerminated: Effect.Effect<boolean>;
  readonly awaitTermination: Effect.Effect<never, CodexTransportFailure>;
}

type PendingRequest = {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, CodexTransportFailure>;
};

type RequestState =
  | {
      readonly _tag: "Running";
      readonly pending: ReadonlyMap<number, PendingRequest>;
    }
  | {
      readonly _tag: "Terminated";
      readonly failure: CodexTransportFailure;
    };

const transportError = (operation: string, cause: unknown) =>
  new CodexTransportError({ operation, cause });

const normalizeFailure = (operation: string, error: unknown): CodexTransportFailure => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "CodexTransportError":
      case "CodexRpcError":
      case "AgentProcessExited":
      case "AgentProtocolError":
        return error as CodexTransportFailure;
    }
  }
  return transportError(operation, error);
};

export const makeCodexTransport = (
  options: CodexTransportOptions = {},
): Effect.Effect<
  CodexTransport,
  CodexTransportError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          options.executablePath ?? "codex",
          ["app-server", ...(options.args ?? [])],
          {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            forceKillAfter: options.forceKillAfter ?? DEFAULT_FORCE_KILL_AFTER,
          },
        ),
      )
      .pipe(Effect.mapError((cause) => transportError("spawn", cause)));

    const outgoing = yield* Queue.bounded<string>(queueCapacity);
    const notifications = yield* Queue.bounded<ServerNotification, CodexTransportFailure>(
      queueCapacity,
    );
    const serverRequests = yield* Queue.bounded<ServerRequest, CodexTransportFailure>(
      queueCapacity,
    );
    const requestState = yield* Ref.make<RequestState>({
      _tag: "Running",
      pending: new Map(),
    });
    const nextRequestId = yield* Ref.make(1);
    const termination = yield* Deferred.make<never, CodexTransportFailure>();
    const stderrTail = yield* Ref.make("");
    const stderrDrained = yield* Deferred.make<void>();
    const encoder = new TextEncoder();

    const terminate = (error: CodexTransportFailure) =>
      Ref.modify(requestState, (current) => {
        if (current._tag === "Terminated") return [undefined, current] as const;
        return [
          Array.from(current.pending.values()),
          { _tag: "Terminated", failure: error } as const,
        ] as const;
      }).pipe(
        Effect.flatMap((requests) => {
          if (!requests) return Effect.void;
          return Effect.forEach(requests, ({ deferred }) => Deferred.fail(deferred, error), {
            discard: true,
          }).pipe(
            Effect.andThen(Deferred.fail(termination, error)),
            Effect.andThen(Queue.fail(notifications, error)),
            Effect.andThen(Queue.fail(serverRequests, error)),
            Effect.andThen(Queue.shutdown(outgoing)),
            Effect.asVoid,
          );
        }),
      );

    const offerOutgoing = (
      frame: Record<string, unknown>,
    ): Effect.Effect<void, CodexTransportError> =>
      Effect.gen(function* () {
        const encoded = yield* Effect.try({
          try: () => `${JSON.stringify(frame)}\n`,
          catch: (cause) => transportError("encode-frame", cause),
        });
        const accepted = yield* Queue.offer(outgoing, encoded);
        if (!accepted) {
          return yield* transportError("write-closed", new Error("Codex transport is closed"));
        }
      });

    const removePending = (id: number) =>
      Ref.update(requestState, (current) => {
        if (current._tag === "Terminated" || !current.pending.has(id)) return current;
        const pending = new Map(current.pending);
        pending.delete(id);
        return { _tag: "Running", pending } as const;
      });

    const resolvePending = (
      id: number,
      complete: (request: PendingRequest) => Effect.Effect<void>,
    ) =>
      Ref.modify(requestState, (current) => {
        if (current._tag === "Terminated") return [Effect.void, current] as const;
        const request = current.pending.get(id);
        if (!request) return [Effect.void, current] as const;
        const pending = new Map(current.pending);
        pending.delete(id);
        return [complete(request), { _tag: "Running", pending } as const] as const;
      }).pipe(Effect.flatten);

    const handleFrame = (line: string): Effect.Effect<void, CodexTransportFailure> =>
      Effect.gen(function* () {
        if (line.trim().length === 0) return;
        const decoded = yield* Effect.try({
          try: () => JSON.parse(line) as unknown,
          catch: (cause) =>
            new AgentProtocolError({
              harnessAgentId: "codex",
              reason: "Received invalid JSON from app-server",
              cause,
            }),
        });
        if (!isRpcFrame(decoded)) {
          return yield* new AgentProtocolError({
            harnessAgentId: "codex",
            reason: "Received an invalid app-server frame",
          });
        }

        if ("method" in decoded) {
          if (decoded.id === undefined) {
            yield* Queue.offer(notifications, decoded as unknown as ServerNotification);
          } else {
            yield* Queue.offer(serverRequests, decoded as unknown as ServerRequest);
          }
          return;
        }

        if ("error" in decoded) {
          yield* resolvePending(decoded.id, ({ deferred, method }) =>
            Deferred.fail(
              deferred,
              new CodexRpcError({
                method,
                code: decoded.error.code,
                errorMessage: decoded.error.message,
                ...(decoded.error.data !== undefined ? { data: decoded.error.data } : {}),
              }),
            ),
          );
          return;
        }

        yield* resolvePending(decoded.id, ({ deferred }) =>
          Deferred.succeed(deferred, decoded.result),
        );
      });

    yield* Stream.fromQueue(outgoing).pipe(
      Stream.map((frame) => encoder.encode(frame)),
      Stream.run(child.stdin),
      Effect.catch((cause) => terminate(transportError("write-stdin", cause))),
      Effect.forkScoped,
    );

    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach(handleFrame),
      Effect.catch((error) => terminate(normalizeFailure("read-stdout", error))),
      Effect.forkScoped,
    );

    // The protocol uses stdout only, but stderr must still be drained or a noisy
    // child can fill the OS pipe and deadlock before it emits its response.
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.update(stderrTail, (current) => (current + chunk).slice(-8192)),
      ),
      Effect.catch((error) => terminate(transportError("read-stderr", error))),
      Effect.ensuring(Deferred.succeed(stderrDrained, undefined)),
      Effect.forkScoped,
    );

    yield* child.exitCode.pipe(
      Effect.flatMap((code) =>
        Deferred.await(stderrDrained).pipe(
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.void }),
          Effect.andThen(Ref.get(stderrTail)),
          Effect.flatMap((tail) =>
            terminate(
              new AgentProcessExited({
                harnessAgentId: "codex",
                code,
                ...(tail.length > 0 ? { stderrTail: tail } : {}),
              }),
            ),
          ),
        ),
      ),
      Effect.catch((cause) => terminate(transportError("read-exit-code", cause))),
      Effect.forkScoped,
    );

    yield* Effect.addFinalizer(() =>
      terminate(transportError("shutdown", new Error("Codex transport scope closed"))).pipe(
        Effect.andThen(Queue.shutdown(notifications)),
        Effect.andThen(Queue.shutdown(serverRequests)),
        Effect.asVoid,
      ),
    );

    const request: CodexTransport["request"] = <A>(method: string, params?: unknown) =>
      Effect.gen(function* () {
        const id = yield* Ref.getAndUpdate(nextRequestId, (current) => current + 1);
        const deferred = yield* Deferred.make<unknown, CodexTransportFailure>();
        const terminalFailure = yield* Ref.modify(requestState, (current) => {
          if (current._tag === "Terminated") return [current.failure, current] as const;
          const pending = new Map(current.pending).set(id, { method, deferred });
          return [undefined, { _tag: "Running", pending } as const] as const;
        });
        if (terminalFailure) return yield* terminalFailure;

        return (yield* offerOutgoing({
          method,
          id,
          ...(params !== undefined ? { params } : {}),
        }).pipe(
          Effect.tapError(() => removePending(id)),
          Effect.andThen(Deferred.await(deferred)),
          Effect.onInterrupt(() => removePending(id)),
        )) as A;
      });

    return {
      request,
      notify: (method, params) =>
        offerOutgoing({ method, ...(params !== undefined ? { params } : {}) }),
      notifications: Stream.fromQueue(notifications),
      serverRequests: Stream.fromQueue(serverRequests),
      respond: (id, result) => offerOutgoing({ id, result }),
      respondError: (id, error) => offerOutgoing({ id, error }),
      isTerminated: Ref.get(requestState).pipe(Effect.map((state) => state._tag === "Terminated")),
      awaitTermination: Deferred.await(termination),
    } satisfies CodexTransport;
  });
