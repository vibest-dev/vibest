import { assert, describe, it } from "@effect/vitest"
import { capture, reconnectSchedule } from "@vibest/plugin"
import { Duration, Effect, Fiber, Schedule, Stream } from "effect"
import { Sink } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"

const handle = (options: {
  readonly stdout: Stream.Stream<Uint8Array>
  readonly stderr: Stream.Stream<Uint8Array>
  readonly exitCode: Effect.Effect<number>
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.map(options.exitCode, (code) => ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: options.stdout,
    stderr: options.stderr,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  })

const text = (value: string) => Stream.make(new TextEncoder().encode(value))

describe("capture", () => {
  it.effect("returns stdout, stderr and the exit code, and forwards the spawn options", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return Effect.die("piped")
        assert.strictEqual(command.command, "lsof")
        assert.deepStrictEqual([...command.args], ["-p"])
        assert.deepStrictEqual(
          {
            stdin: command.options.stdin,
            cwd: command.options.cwd,
            env: command.options.env,
            extendEnv: command.options.extendEnv,
            forceKillAfter: command.options.forceKillAfter,
          },
          {
            stdin: "ignore",
            cwd: "/tmp",
            env: { HOME: "/tmp", VIBEST_SESSION_ID: undefined },
            extendEnv: true,
            forceKillAfter: "1 second",
          },
        )
        return Effect.succeed(handle({ stdout: text("out\n"), stderr: text("err\n"), exitCode: Effect.succeed(2) }))
      })
      const run = yield* capture("lsof", ["-p"], {
        stdin: "ignore",
        cwd: "/tmp",
        env: { HOME: "/tmp", VIBEST_SESSION_ID: undefined },
        extendEnv: true,
        forceKillAfter: "1 second",
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      assert.deepStrictEqual(run, { exitCode: 2, stdout: "out\n", stderr: "err\n" })
    }),
  )

  it.effect("a timeout is undefined", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return Effect.die("piped")
        return Effect.succeed(handle({ stdout: Stream.never, stderr: Stream.empty, exitCode: Effect.never }))
      })
      const fiber = yield* Effect.forkChild(
        capture("sleep", ["10"], { timeout: "1 second" }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      )
      yield* TestClock.adjust("1 second")
      assert.isUndefined(yield* Fiber.join(fiber))
    }),
  )
})

describe("reconnectSchedule", () => {
  it.effect("starts at first, doubles, caps at max, and a new step starts over", () =>
    Effect.gen(function* () {
      const schedule = reconnectSchedule({ first: "500 millis", max: "3 seconds" })
      const step = yield* Schedule.toStep(schedule)
      const delays: Array<number> = []
      for (let i = 0; i < 5; i++) {
        const [, delay] = yield* Effect.orDie(step(0, undefined))
        delays.push(Duration.toMillis(delay))
      }
      assert.deepStrictEqual(delays, [500, 1000, 2000, 3000, 3000])
      const again = yield* Schedule.toStep(schedule)
      const [, first] = yield* Effect.orDie(again(0, undefined))
      assert.strictEqual(Duration.toMillis(first), 500)
    }),
  )
})
