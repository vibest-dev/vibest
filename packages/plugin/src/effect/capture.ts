import { Duration, Effect, Option, type PlatformError, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface Captured {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface CaptureOptions {
  readonly stdin?: ChildProcess.CommandInput | undefined
  readonly cwd?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
  readonly extendEnv?: boolean | undefined
  readonly forceKillAfter?: Duration.Input | undefined
  readonly timeout?: Duration.Input | undefined
}

const collected = (command: string, args: ReadonlyArray<string>, options: CaptureOptions | undefined) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options?.env === undefined ? {} : { env: options.env }),
        ...(options?.extendEnv === undefined ? {} : { extendEnv: options.extendEnv }),
        ...(options?.forceKillAfter === undefined ? {} : { forceKillAfter: options.forceKillAfter }),
      }),
    )
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    )
    return { exitCode, stdout, stderr } satisfies Captured
  }).pipe(Effect.scoped)

export const capture = (
  command: string,
  args: ReadonlyArray<string>,
  options?: CaptureOptions,
): Effect.Effect<Captured | undefined, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner> => {
  const ran = collected(command, args, options)
  return options?.timeout === undefined
    ? ran
    : ran.pipe(Effect.timeoutOption(options.timeout), Effect.map(Option.getOrUndefined))
}
