import os from "node:os"
import path from "node:path"

import { deserializeMessage, serializeMessage, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client"
import { Cause, Duration, Effect, Fiber, FileSystem, Option, Path, Queue, Result, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { NpxResolver } from "./npx-resolver.ts"

export * as McpStdio from "./stdio.ts"

const CLOSE_GRACE = Duration.seconds(2)
const FORCE_KILL_AFTER = Duration.seconds(2)
const OUTGOING_CAPACITY = 64
const MAX_FRAME_BYTES = 16 * 1024 * 1024
const EXIT_WAIT = Duration.seconds(1)
const STDERR_TAIL = 1_000

export interface Options {
  readonly server: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly vibestHome?: string | undefined
  readonly npmCacheDir?: string | undefined
  readonly resolveNpx?: boolean | undefined
}

interface StdioState {
  phase: "ready" | "starting" | "open" | "closed"
  handle: ChildProcessSpawner.ChildProcessHandle | undefined
  startup: Promise<void> | undefined
  closing: Promise<void> | undefined
  pending: Array<Uint8Array>
  pendingBytes: number
  stderr: string
}

export const resolveCwd = (directory: string, cwd: string | undefined): string => {
  if (!cwd) return directory

  if (cwd === "~") return os.homedir()

  if (cwd.startsWith("~/")) return path.join(os.homedir(), cwd.slice(2))

  return path.resolve(directory, cwd)
}

export const make = Effect.fn("McpStdio.make")(function* (options: Options) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const pathSvc = yield* Path.Path
  const scope = yield* Effect.scope
  const outgoing = yield* Queue.bounded<string, Cause.Done>(OUTGOING_CAPACITY)

  const state: StdioState = {
    phase: "ready",
    handle: undefined,
    startup: undefined,
    closing: undefined,
    pending: [],
    pendingBytes: 0,
    stderr: "",
  }

  const decoder = new TextDecoder()

  const killGroup = (pid: number, signal: "SIGTERM" | "SIGKILL") =>
    Effect.sync(() => {
      if (process.platform === "win32") return

      try {
        process.kill(-pid, signal)
      } catch {
        return
      }
    })

  const stop = Effect.fn("McpStdio.stop")(function* (handle: ChildProcessSpawner.ChildProcessHandle) {
    yield* Effect.timeoutOption(handle.exitCode, CLOSE_GRACE).pipe(Effect.ignore)
    yield* killGroup(Number(handle.pid), "SIGTERM")
    yield* handle.kill({ killSignal: "SIGTERM", forceKillAfter: FORCE_KILL_AFTER }).pipe(Effect.ignore)
    yield* killGroup(Number(handle.pid), "SIGKILL")
  })

  const close = () => {
    if (state.closing) return state.closing
    state.closing = Effect.runPromise(
      Effect.gen(function* () {
        state.phase = "closed"
        state.pending = []
        state.pendingBytes = 0
        Queue.endUnsafe(outgoing)

        if (state.startup) yield* Effect.promise(() => state.startup!.catch(() => undefined))
        const handle = state.handle

        if (!handle) return
        state.handle = undefined
        yield* stop(handle)
      }).pipe(Effect.ensuring(Queue.shutdown(outgoing))),
    )

    return state.closing
  }

  yield* Scope.addFinalizer(scope, Effect.promise(() => close()).pipe(Effect.ignore))

  const transport: Transport & { readonly pid: number | null; readonly stderr: null } = {
    get pid() {
      return state.handle ? Number(state.handle.pid) : null
    },
    stderr: null,
    start: () => {
      if (state.phase !== "ready") return Promise.reject(new Error("Stdio transport already started"))
      state.phase = "starting"
      state.startup = Effect.runPromise(
        Effect.gen(function* () {
          const resolved =
            options.resolveNpx !== false && options.vibestHome !== undefined
              ? yield* NpxResolver.rewriteCommand({
                  command: options.command,
                  args: options.args,
                  vibestHome: options.vibestHome,
                  npmCacheDir: options.npmCacheDir,
                  spawner,
                }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, pathSvc))
              : { command: options.command, args: options.args, resolved: false }

          const handle = yield* spawner.spawn(
            ChildProcess.make(resolved.command, [...resolved.args], {
              cwd: options.cwd,
              env: { ...options.environment },
              extendEnv: true,
              detached: process.platform !== "win32",
              stdin: { stream: Stream.encodeText(Stream.fromQueue(outgoing)), endOnDone: true },
              stdout: "pipe",
              stderr: "pipe",
              forceKillAfter: FORCE_KILL_AFTER,
            }),
          )

          state.handle = handle

          if (state.phase === "closed") {
            state.handle = undefined

            return yield* stop(handle)
          }

          state.phase = "open"
          yield* startOutput(handle)
        }).pipe(Scope.provide(scope)),
      )

      return state.startup
    },
    send: (message: JSONRPCMessage) =>
      state.phase !== "open"
        ? Promise.reject(new Error("Not connected"))
        : Effect.runPromise(
            Queue.offer(outgoing, serializeMessage(message)).pipe(
              Effect.flatMap((offered) => (offered ? Effect.void : Effect.fail(new Error("Not connected")))),
            ),
          ),
    close,
  }

  const oversized = () => {
    transport.onerror?.(
      new Error(`MCP server ${options.server} wrote more than 16 MiB to stdout without a message boundary`),
    )
    void close()
  }

  const receive = (line: Uint8Array) => {
    const text = decoder.decode(line.at(-1) === 13 ? line.subarray(0, -1) : line)

    if (text.trim() === "") return

    const message = Result.try({
      try: () => deserializeMessage(text),
      catch: (cause) => new Error(`Invalid MCP stdio message from ${options.server}: ${String(cause)}`, { cause }),
    })

    if (Result.isFailure(message)) {
      transport.onerror?.(message.failure)

      return
    }

    transport.onmessage?.(message.success)
  }

  const deliver = (chunk: Uint8Array) => {
    let start = 0
    let newline = chunk.indexOf(10)

    while (newline !== -1 && state.phase !== "closed") {
      const line = chunk.subarray(start, newline)
      const size = state.pendingBytes + line.length

      if (size > MAX_FRAME_BYTES) return oversized()
      receive(state.pending.length === 0 ? line : Buffer.concat([...state.pending, line], size))
      state.pending = []
      state.pendingBytes = 0
      start = newline + 1
      newline = chunk.indexOf(10, start)
    }

    if (start === chunk.length || state.phase === "closed") return
    state.pendingBytes += chunk.length - start

    if (state.pendingBytes > MAX_FRAME_BYTES) return oversized()
    state.pending.push(start === 0 ? chunk : chunk.subarray(start))
  }

  const startOutput = (handle: ChildProcessSpawner.ChildProcessHandle) =>
    Effect.gen(function* () {
      const drain = yield* Effect.forkScoped(
        handle.stderr.pipe(
          Stream.decodeText(),
          Stream.tap((output) =>
            Effect.sync(() => {
              state.stderr = (state.stderr + output).slice(-STDERR_TAIL)
            }),
          ),
          Stream.runForEach((output) =>
            output.trim() === ""
              ? Effect.void
              : Effect.logDebug("mcp server stderr", { server: options.server, output }),
          ),
          Effect.ignore,
        ),
      )

      yield* Effect.forkScoped(
        Stream.runForEach(handle.stdout, (chunk) => Effect.sync(() => deliver(chunk))).pipe(
          Effect.tapCause((cause) =>
            Effect.sync(() => {
              const error = Cause.squash(cause)
              transport.onerror?.(error instanceof Error ? error : new Error(String(error)))
            }),
          ),
          Effect.ignore,
          Effect.ensuring(
            Effect.gen(function* () {
              const unexpected = state.phase !== "closed"

              if (unexpected) {
                const code = yield* Fiber.await(drain).pipe(
                  Effect.andThen(handle.exitCode),
                  Effect.timeoutOption(EXIT_WAIT),
                  Effect.orElseSucceed(() => Option.none<ChildProcessSpawner.ExitCode>()),
                )

                const exited = Option.match(code, {
                  onNone: () => "MCP server process exited",
                  onSome: (exitCode) => `MCP server process exited with code ${exitCode}`,
                })

                const output = state.stderr.trim()
                transport.onerror?.(new Error(output ? `${exited}: ${output}` : exited))
                yield* Effect.promise(close)
              }

              transport.onclose?.()
            }),
          ),
        ),
      )
    })

  return transport
})
