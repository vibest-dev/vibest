import { Deferred, type Duration, Effect, Queue, Ref, Stream, type Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  AgentProcessExited,
  AgentProtocolError,
  GrokRpcError,
  GrokTransportError,
} from "../errors";
import { isRpcFrame, type RpcNotification, type RpcServerRequest } from "./protocol";

const DEFAULT_QUEUE_CAPACITY = 256;
const DEFAULT_FORCE_KILL_AFTER = "2 seconds";

export type GrokTransportFailure =
  | GrokTransportError
  | GrokRpcError
  | AgentProcessExited
  | AgentProtocolError;

export interface GrokTransportOptions {
  readonly executablePath: string;
  readonly cwd?: string;
  readonly args?: ReadonlyArray<string>;
  readonly queueCapacity?: number;
  readonly forceKillAfter?: Duration.Input;
  readonly env?: NodeJS.ProcessEnv;
}

export interface GrokTransport {
  readonly request: <A>(method: string, params?: unknown) => Effect.Effect<A, GrokTransportFailure>;
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void, GrokTransportError>;
  readonly notifications: Stream.Stream<RpcNotification, GrokTransportFailure>;
  readonly serverRequests: Stream.Stream<RpcServerRequest, GrokTransportFailure>;
  readonly respond: (
    id: string | number,
    result: unknown,
  ) => Effect.Effect<void, GrokTransportError>;
  readonly respondError: (
    id: string | number,
    error: { readonly code: number; readonly message: string; readonly data?: unknown },
  ) => Effect.Effect<void, GrokTransportError>;
  readonly isTerminated: Effect.Effect<boolean>;
  readonly awaitTermination: Effect.Effect<never, GrokTransportFailure>;
}

type PendingRequest = {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, GrokTransportFailure>;
};

type RequestState =
  | {
      readonly _tag: "Running";
      readonly pending: ReadonlyMap<number, PendingRequest>;
    }
  | {
      readonly _tag: "Terminated";
      readonly failure: GrokTransportFailure;
    };

const transportError = (operation: string, cause: unknown) =>
  new GrokTransportError({ operation, cause });

const normalizeFailure = (operation: string, error: unknown): GrokTransportFailure => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "GrokTransportError":
      case "GrokRpcError":
      case "AgentProcessExited":
      case "AgentProtocolError":
        return error as GrokTransportFailure;
    }
  }
  return transportError(operation, error);
};

export const makeGrokTransport = (
  options: GrokTransportOptions,
): Effect.Effect<
  GrokTransport,
  GrokTransportError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    const env = {
      ...process.env,
      GROK_DISABLE_AUTOUPDATER: "1",
      ...options.env,
    };
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          options.executablePath,
          ["agent", "--no-leader", "stdio", ...(options.args ?? [])],
          {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            env,
            forceKillAfter: options.forceKillAfter ?? DEFAULT_FORCE_KILL_AFTER,
          },
        ),
      )
      .pipe(Effect.mapError((cause) => transportError("spawn", cause)));

    const outgoing = yield* Queue.bounded<string>(queueCapacity);
    const notifications = yield* Queue.bounded<RpcNotification, GrokTransportFailure>(
      queueCapacity,
    );
    const serverRequests = yield* Queue.bounded<RpcServerRequest, GrokTransportFailure>(
      queueCapacity,
    );
    const requestState = yield* Ref.make<RequestState>({
      _tag: "Running",
      pending: new Map(),
    });
    const nextRequestId = yield* Ref.make(1);
    const termination = yield* Deferred.make<never, GrokTransportFailure>();
    const stderrTail = yield* Ref.make("");
    const stderrDrained = yield* Deferred.make<void>();
    const encoder = new TextEncoder();

    const terminate = (error: GrokTransportFailure) =>
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
    ): Effect.Effect<void, GrokTransportError> =>
      Effect.gen(function* () {
        const encoded = yield* Effect.try({
          try: () => `${JSON.stringify(frame)}\n`,
          catch: (cause) => transportError("encode-frame", cause),
        });
        const accepted = yield* Queue.offer(outgoing, encoded);
        if (!accepted) {
          return yield* transportError("write-closed", new Error("Grok transport is closed"));
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

    const handleFrame = (line: string): Effect.Effect<void, GrokTransportFailure> =>
      Effect.gen(function* () {
        if (line.trim().length === 0) return;
        let decoded: unknown;
        try {
          decoded = JSON.parse(line) as unknown;
        } catch {
          // Grok may print a human banner on stdout before the JSON-RPC loop.
          return;
        }
        if (!isRpcFrame(decoded)) {
          // Banners, log lines, and future `_x.ai/*` notices that aren't a
          // JSON-RPC frame: skip. Killing the child here would turn a protocol
          // extension into a session crash.
          return;
        }

        if ("method" in decoded) {
          if (decoded.id === undefined) {
            yield* Queue.offer(notifications, decoded as RpcNotification);
          } else {
            yield* Queue.offer(serverRequests, decoded as RpcServerRequest);
          }
          return;
        }

        const id = typeof decoded.id === "number" ? decoded.id : Number(decoded.id);
        if (!Number.isFinite(id)) return;

        if ("error" in decoded) {
          yield* resolvePending(id, ({ deferred, method }) =>
            Deferred.fail(
              deferred,
              new GrokRpcError({
                method,
                code: decoded.error.code,
                errorMessage: decoded.error.message,
                ...(decoded.error.data !== undefined ? { data: decoded.error.data } : {}),
              }),
            ),
          );
          return;
        }

        yield* resolvePending(id, ({ deferred }) => Deferred.succeed(deferred, decoded.result));
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
                harnessAgentId: "grok",
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
      terminate(transportError("shutdown", new Error("Grok transport scope closed"))).pipe(
        Effect.andThen(Queue.shutdown(notifications)),
        Effect.andThen(Queue.shutdown(serverRequests)),
        Effect.asVoid,
      ),
    );

    const request: GrokTransport["request"] = <A>(method: string, params?: unknown) =>
      Effect.gen(function* () {
        const id = yield* Ref.getAndUpdate(nextRequestId, (current) => current + 1);
        const deferred = yield* Deferred.make<unknown, GrokTransportFailure>();
        const terminalFailure = yield* Ref.modify(requestState, (current) => {
          if (current._tag === "Terminated") return [current.failure, current] as const;
          const pending = new Map(current.pending).set(id, { method, deferred });
          return [undefined, { _tag: "Running", pending } as const] as const;
        });
        if (terminalFailure) return yield* terminalFailure;

        return (yield* offerOutgoing({
          jsonrpc: "2.0",
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
        offerOutgoing({
          jsonrpc: "2.0",
          method,
          ...(params !== undefined ? { params } : {}),
        }),
      notifications: Stream.fromQueue(notifications),
      serverRequests: Stream.fromQueue(serverRequests),
      respond: (id, result) => offerOutgoing({ jsonrpc: "2.0", id, result }),
      respondError: (id, error) => offerOutgoing({ jsonrpc: "2.0", id, error }),
      isTerminated: Ref.get(requestState).pipe(Effect.map((state) => state._tag === "Terminated")),
      awaitTermination: Deferred.await(termination),
    } satisfies GrokTransport;
  });
