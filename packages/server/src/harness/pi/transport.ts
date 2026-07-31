import { Deferred, type Duration, Effect, Queue, Ref, Stream, type Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { AgentProcessExited, PiRpcError, PiTransportError } from "../errors";
import {
  isBlockingUiRequest,
  type AgentSessionEvent,
  type PiUiRequest,
  type RpcCommand,
  type RpcExtensionUIResponse,
} from "./protocol";

const DEFAULT_QUEUE_CAPACITY = 256;
const DEFAULT_FORCE_KILL_AFTER = "2 seconds";

export type PiTransportFailure = PiTransportError | PiRpcError | AgentProcessExited;

export interface PiTransportOptions {
  readonly executablePath?: string;
  /** Pi resolves its per-project session directory from the child's cwd. */
  readonly cwd?: string;
  /** Passed as `--session-id` — pi loads the session, creating it if missing. */
  readonly sessionId?: string;
  readonly args?: ReadonlyArray<string>;
  readonly queueCapacity?: number;
  readonly forceKillAfter?: Duration.Input;
}

export interface PiTransport {
  /** Send a command and await its correlated response; resolves with `data`. */
  readonly command: <A = void>(command: RpcCommand) => Effect.Effect<A, PiTransportFailure>;
  /** Single-consumer stream owned by the facade event router. */
  readonly events: Stream.Stream<AgentSessionEvent, PiTransportFailure>;
  /** Blocking extension-UI requests (confirm/select/input/editor). Single-consumer. */
  readonly uiRequests: Stream.Stream<PiUiRequest, PiTransportFailure>;
  readonly respondUi: (response: RpcExtensionUIResponse) => Effect.Effect<void, PiTransportError>;
  readonly isTerminated: Effect.Effect<boolean>;
  readonly awaitTermination: Effect.Effect<never, PiTransportFailure>;
}

type PendingCommand = {
  readonly command: string;
  readonly deferred: Deferred.Deferred<unknown, PiTransportFailure>;
};

type CommandState =
  | { readonly _tag: "Running"; readonly pending: ReadonlyMap<string, PendingCommand> }
  | { readonly _tag: "Terminated"; readonly failure: PiTransportFailure };

const transportError = (operation: string, cause: unknown) =>
  new PiTransportError({ operation, cause });

const normalizeFailure = (operation: string, error: unknown): PiTransportFailure => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "PiTransportError":
      case "PiRpcError":
      case "AgentProcessExited":
        return error as PiTransportFailure;
    }
  }
  return transportError(operation, error);
};

export const makePiTransport = (
  options: PiTransportOptions = {},
): Effect.Effect<
  PiTransport,
  PiTransportError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          options.executablePath ?? "pi",
          [
            "--mode",
            "rpc",
            ...(options.sessionId ? ["--session-id", options.sessionId] : []),
            ...(options.args ?? []),
          ],
          {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            forceKillAfter: options.forceKillAfter ?? DEFAULT_FORCE_KILL_AFTER,
          },
        ),
      )
      .pipe(Effect.mapError((cause) => transportError("spawn", cause)));

    const outgoing = yield* Queue.bounded<string>(queueCapacity);
    const events = yield* Queue.bounded<AgentSessionEvent, PiTransportFailure>(queueCapacity);
    const uiRequests = yield* Queue.bounded<PiUiRequest, PiTransportFailure>(queueCapacity);
    const commandState = yield* Ref.make<CommandState>({ _tag: "Running", pending: new Map() });
    const nextCommandId = yield* Ref.make(1);
    const termination = yield* Deferred.make<never, PiTransportFailure>();
    const stderrTail = yield* Ref.make("");
    const stderrDrained = yield* Deferred.make<void>();
    const encoder = new TextEncoder();

    const terminate = (error: PiTransportFailure) =>
      Ref.modify(commandState, (current) => {
        if (current._tag === "Terminated") return [undefined, current] as const;
        return [
          Array.from(current.pending.values()),
          { _tag: "Terminated", failure: error } as const,
        ] as const;
      }).pipe(
        Effect.flatMap((commands) => {
          if (!commands) return Effect.void;
          return Effect.forEach(commands, ({ deferred }) => Deferred.fail(deferred, error), {
            discard: true,
          }).pipe(
            Effect.andThen(Deferred.fail(termination, error)),
            Effect.andThen(Queue.fail(events, error)),
            Effect.andThen(Queue.fail(uiRequests, error)),
            Effect.andThen(Queue.shutdown(outgoing)),
            Effect.asVoid,
          );
        }),
      );

    const offerOutgoing = (frame: Record<string, unknown>): Effect.Effect<void, PiTransportError> =>
      Effect.gen(function* () {
        const encoded = yield* Effect.try({
          try: () => `${JSON.stringify(frame)}\n`,
          catch: (cause) => transportError("encode-frame", cause),
        });
        const accepted = yield* Queue.offer(outgoing, encoded);
        if (!accepted) {
          return yield* transportError("write-closed", new Error("Pi transport is closed"));
        }
      });

    const removePending = (id: string) =>
      Ref.update(commandState, (current) => {
        if (current._tag === "Terminated" || !current.pending.has(id)) return current;
        const pending = new Map(current.pending);
        pending.delete(id);
        return { _tag: "Running", pending } as const;
      });

    const resolvePending = (
      id: string,
      complete: (command: PendingCommand) => Effect.Effect<void>,
    ) =>
      Ref.modify(commandState, (current) => {
        if (current._tag === "Terminated") return [Effect.void, current] as const;
        const pending = current.pending.get(id);
        if (!pending) return [Effect.void, current] as const;
        const next = new Map(current.pending);
        next.delete(id);
        return [complete(pending), { _tag: "Running", pending: next } as const] as const;
      }).pipe(Effect.flatten);

    const handleFrame = (line: string): Effect.Effect<void, PiTransportFailure> =>
      Effect.gen(function* () {
        if (line.trim().length === 0) return;
        let decoded: unknown;
        try {
          decoded = JSON.parse(line);
        } catch {
          // Pi's CLI front-end prints human-readable startup errors ("No
          // session found matching …") to stdout before the RPC loop takes
          // over — skip anything that isn't a frame instead of failing.
          return;
        }
        if (typeof decoded !== "object" || decoded === null) return;
        const frame = decoded as { type?: unknown; id?: unknown };
        if (typeof frame.type !== "string") return;

        if (frame.type === "response") {
          const response = frame as {
            id?: string;
            command: string;
            success: boolean;
            data?: unknown;
            error?: string;
          };
          if (response.id === undefined) return;
          yield* resolvePending(response.id, ({ deferred, command }) =>
            response.success
              ? Deferred.succeed(deferred, response.data).pipe(Effect.asVoid)
              : Deferred.fail(
                  deferred,
                  new PiRpcError({
                    command,
                    errorMessage: response.error ?? "unknown error",
                  }),
                ).pipe(Effect.asVoid),
          );
          return;
        }

        if (frame.type === "extension_ui_request") {
          const request = decoded as Parameters<typeof isBlockingUiRequest>[0];
          // Fire-and-forget display hints (notify/setStatus/setWidget/…) need
          // no reply and have no chunk-track meaning — drop them.
          if (isBlockingUiRequest(request)) yield* Queue.offer(uiRequests, request);
          return;
        }

        if (frame.type === "extension_error") return;

        yield* Queue.offer(events, decoded as AgentSessionEvent);
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

    // Stderr must be drained or a noisy child can fill the OS pipe and deadlock.
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
                harnessAgentId: "pi",
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
      terminate(transportError("shutdown", new Error("Pi transport scope closed"))).pipe(
        Effect.andThen(Queue.shutdown(events)),
        Effect.andThen(Queue.shutdown(uiRequests)),
        Effect.asVoid,
      ),
    );

    const command: PiTransport["command"] = <A>(input: RpcCommand) =>
      Effect.gen(function* () {
        const id = String(yield* Ref.getAndUpdate(nextCommandId, (current) => current + 1));
        const deferred = yield* Deferred.make<unknown, PiTransportFailure>();
        const terminalFailure = yield* Ref.modify(commandState, (current) => {
          if (current._tag === "Terminated") return [current.failure, current] as const;
          const pending = new Map(current.pending).set(id, { command: input.type, deferred });
          return [undefined, { _tag: "Running", pending } as const] as const;
        });
        if (terminalFailure) return yield* terminalFailure;

        return (yield* offerOutgoing({ ...input, id }).pipe(
          Effect.tapError(() => removePending(id)),
          Effect.andThen(Deferred.await(deferred)),
          Effect.onInterrupt(() => removePending(id)),
        )) as A;
      });

    return {
      command,
      events: Stream.fromQueue(events),
      uiRequests: Stream.fromQueue(uiRequests),
      respondUi: (response) => offerOutgoing({ ...response }),
      isTerminated: Ref.get(commandState).pipe(Effect.map((state) => state._tag === "Terminated")),
      awaitTermination: Deferred.await(termination),
    } satisfies PiTransport;
  });
