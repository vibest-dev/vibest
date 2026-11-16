import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Sink, Stdio, Stream } from "effect"
import { TestClock } from "effect/testing"

import { soleEntry } from "../src/commands/handlers/default.ts"

const stdio = (terminal: boolean, stdin: Stream.Stream<Uint8Array>) =>
  Stdio.layerTest({
    stdinIsTerminal: Effect.succeed(terminal),
    stdoutIsTerminal: Effect.succeed(terminal),
    stdin,
    stdout: () => Sink.drain,
  })
const typed = (text: string) => Stream.make(new TextEncoder().encode(text))

const recordingClient = (stop: "stopped" | "running" | "moved" | "unsupported" = "stopped") => {
  const calls: Array<string> = []
  const client = {
    "Project.RunningEntry": () =>
      Effect.sync(() => {
        calls.push("RunningEntry")
        return { harness: "claude" as const, place: "herdr w1:p1", runtime: "herdr", address: "{}" }
      }),
    "Project.StopEntry": () =>
      Effect.sync(() => {
        calls.push("StopEntry")
        return stop === "unsupported" ? { result: stop, reason: "it runs on another machine" } : { result: stop }
      }),
  } as unknown as Parameters<typeof soleEntry>[0]
  const start = Effect.sync(() => {
    calls.push("start")
    return "started"
  })
  return { calls, run: soleEntry(client, "w1:p2", start) }
}

describe("soleEntry while the entry session runs in another terminal", () => {
  for (const [name, terminal, stdin] of [
    ["N", true, typed("n\n")],
    ["empty", true, typed("\n")],
    ["EOF", true, Stream.empty],
    ["not a terminal", false, typed("y\n")],
  ] as const)
    it.effect(`${name}: fails naming where it runs, starts nothing, stops nothing`, () =>
      Effect.gen(function* () {
        const f = recordingClient()
        const exit = yield* Effect.exit(f.run)
        assert.isTrue(Exit.isFailure(exit))
        assert.include(String(exit), "the entry session (claude) runs in herdr w1:p1")
        assert.deepStrictEqual(f.calls, ["RunningEntry"])
      }).pipe(Effect.provide(stdio(terminal, stdin))),
    )

  it.effect("no answer within two minutes: fails, starts nothing, stops nothing", () =>
    Effect.gen(function* () {
      const f = recordingClient()
      const fiber = yield* Effect.forkChild(Effect.exit(f.run))
      yield* TestClock.adjust("2 minutes")
      assert.isTrue(Exit.isFailure(yield* Fiber.join(fiber)))
      assert.deepStrictEqual(f.calls, ["RunningEntry"])
    }).pipe(Effect.provide(stdio(true, Stream.never))),
  )

  it.effect(
    "y without a finished stop (running, moved, unsupported) fails and starts nothing; unsupported says why",
    () =>
      Effect.gen(function* () {
        for (const result of ["running", "moved", "unsupported"] as const) {
          const f = recordingClient(result)
          const exit = yield* Effect.exit(f.run)
          assert.isTrue(Exit.isFailure(exit), result)
          assert.deepStrictEqual(f.calls, ["RunningEntry", "StopEntry"], result)
          if (result === "unsupported") {
            assert.include(String(exit), "cannot be moved from here: it runs on another machine. Exit it there first")
            assert.notInclude(String(exit), "did not exit")
          }
        }
      }).pipe(Effect.provide(stdio(true, typed("y\n")))),
  )
})
