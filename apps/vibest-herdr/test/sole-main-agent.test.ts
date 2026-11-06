import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Sink, Stdio, Stream } from "effect"
import { TestClock } from "effect/testing"

import { soleMainAgent } from "../src/cli.ts"

const stdio = (terminal: boolean, stdin: Stream.Stream<Uint8Array>, out: Array<string> = []) =>
  Stdio.layerTest({
    stdinIsTerminal: Effect.succeed(terminal),
    stdoutIsTerminal: Effect.succeed(terminal),
    stdin,
    stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => out.push(String(chunk)))),
  })
const typed = (text: string) => Stream.make(new TextEncoder().encode(text))

const clientWithMainAgentInW1p1RecordingCalls = (stop: "stopped" | "running" | "moved" | "unsupported" = "stopped") => {
  const calls: Array<string> = []
  const client = {
    "Project.RunningCoordinator": () =>
      Effect.sync(() => {
        calls.push("RunningCoordinator")
        return { harness: "claude" as const, place: "herdr terminal w1:p1", runtime: "herdr", address: "{}" }
      }),
    "Project.StopCoordinator": () =>
      Effect.sync(() => {
        calls.push("StopCoordinator")
        return stop === "unsupported" ? { result: stop, reason: "it runs on another machine" } : { result: stop }
      }),
  } as unknown as Parameters<typeof soleMainAgent>[0]
  const startStandsForCoordinatorSessionAndExec = Effect.sync(() => {
    calls.push("start")
    return "started"
  })
  return { calls, run: soleMainAgent(client, "w1:p2", startStandsForCoordinatorSessionAndExec) }
}

describe("soleMainAgent while the main agent runs in another terminal: only a y whose stop finished starts; anything else starts nothing and never asks to stop (or, after a failed stop, to start)", () => {
  for (const [name, terminal, stdin] of [
    ["N", true, typed("n\n")],
    ["empty", true, typed("\n")],
    ["EOF", true, Stream.empty],
    ["not a terminal", false, typed("y\n")],
  ] as const)
    it.effect(`${name}: fails naming where it runs, starts nothing, stops nothing`, () =>
      Effect.gen(function* () {
        const f = clientWithMainAgentInW1p1RecordingCalls()
        const exit = yield* Effect.exit(f.run)
        assert.isTrue(Exit.isFailure(exit))
        assert.include(String(exit), "the main agent (claude) runs in herdr terminal w1:p1")
        assert.deepStrictEqual(f.calls, ["RunningCoordinator"])
      }).pipe(Effect.provide(stdio(terminal, stdin))),
    )

  it.effect("no answer within two minutes: fails, starts nothing, stops nothing", () =>
    Effect.gen(function* () {
      const f = clientWithMainAgentInW1p1RecordingCalls()
      const fiber = yield* Effect.forkChild(Effect.exit(f.run))
      yield* TestClock.adjust("2 minutes")
      assert.isTrue(Exit.isFailure(yield* Fiber.join(fiber)))
      assert.deepStrictEqual(f.calls, ["RunningCoordinator"])
    }).pipe(Effect.provide(stdio(true, Stream.never))),
  )

  it.effect("y: asks to move it here, stops it, then starts", () => {
    const out: Array<string> = []
    return Effect.gen(function* () {
      const f = clientWithMainAgentInW1p1RecordingCalls("stopped")
      assert.strictEqual(yield* f.run, "started")
      assert.deepStrictEqual(f.calls, ["RunningCoordinator", "StopCoordinator", "start"])
      assert.include(
        out.join(""),
        "The main agent (claude) runs in herdr terminal w1:p1. Move it here and continue? [y/N]",
      )
    }).pipe(Effect.provide(stdio(true, typed("y\n"), out)))
  })

  it.effect("y but the stop did not finish (running) or the main agent moved meanwhile: fails, starts nothing", () =>
    Effect.gen(function* () {
      for (const result of ["running", "moved"] as const) {
        const f = clientWithMainAgentInW1p1RecordingCalls(result)
        const exit = yield* Effect.exit(f.run)
        assert.isTrue(Exit.isFailure(exit), result)
        assert.deepStrictEqual(f.calls, ["RunningCoordinator", "StopCoordinator"], result)
      }
    }).pipe(Effect.provide(stdio(true, typed("y\n")))),
  )

  it.effect("y but it cannot be moved from here: fails saying why, not that it did not exit; starts nothing", () =>
    Effect.gen(function* () {
      const f = clientWithMainAgentInW1p1RecordingCalls("unsupported")
      const exit = yield* Effect.exit(f.run)
      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(exit), "cannot be moved from here: it runs on another machine. Exit it there first")
      assert.notInclude(String(exit), "did not exit")
      assert.deepStrictEqual(f.calls, ["RunningCoordinator", "StopCoordinator"])
    }).pipe(Effect.provide(stdio(true, typed("y\n")))),
  )
})
