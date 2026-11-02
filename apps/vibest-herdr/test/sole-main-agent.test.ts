// `vibest` starting the main agent while the project's main agent runs in another terminal: only a y that closed it
// starts; a no, no answer, EOF or a non-interactive terminal starts nothing and never asks vibestd to stop it.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Stdio, Stream } from "effect"
import { TestClock } from "effect/testing"

import { soleMainAgent } from "../src/cli.ts"

const stdio = (terminal: boolean, stdin: Stream.Stream<Uint8Array>) =>
  Stdio.layerTest({
    stdinIsTerminal: Effect.succeed(terminal),
    stdoutIsTerminal: Effect.succeed(terminal),
    stdin,
  })
const typed = (text: string) => Stream.make(new TextEncoder().encode(text))

/** A client whose main agent runs in test/p1; it records every call, and `start` stands for CoordinatorSession and exec. */
const fake = (stop: "stopped" | "running" | "moved" = "stopped") => {
  const calls: Array<string> = []
  const client = {
    "Project.RunningCoordinator": () =>
      Effect.sync(() => {
        calls.push("RunningCoordinator")
        return { harness: "claude" as const, place: "test/p1", runtime: "herdr", address: "{}" }
      }),
    "Project.StopCoordinator": () =>
      Effect.sync(() => {
        calls.push("StopCoordinator")
        return { result: stop }
      }),
  } as unknown as Parameters<typeof soleMainAgent>[0]
  const start = Effect.sync(() => {
    calls.push("start")
    return "started"
  })
  return { calls, run: soleMainAgent(client, "test/p2", start) }
}

describe("soleMainAgent", () => {
  for (const [name, layer] of [
    ["N", stdio(true, typed("n\n"))],
    ["empty", stdio(true, typed("\n"))],
    ["EOF", stdio(true, Stream.empty)],
    ["not a terminal", stdio(false, typed("y\n"))],
  ] as const)
    it.effect(`${name}: fails naming where it runs, starts nothing, asks vibestd to stop nothing`, () =>
      Effect.gen(function* () {
        const f = fake()
        const exit = yield* Effect.exit(f.run)
        assert.isTrue(Exit.isFailure(exit))
        assert.include(String(exit), "a project has one main agent")
        assert.deepStrictEqual(f.calls, ["RunningCoordinator"])
      }).pipe(Effect.provide(layer)),
    )

  it.effect("no answer within two minutes: fails, starts nothing", () =>
    Effect.gen(function* () {
      const f = fake()
      const fiber = yield* Effect.forkChild(Effect.exit(f.run))
      yield* TestClock.adjust("2 minutes")
      const exit = yield* Fiber.join(fiber)
      assert.isTrue(Exit.isFailure(exit))
      assert.deepStrictEqual(f.calls, ["RunningCoordinator"])
    }).pipe(Effect.provide(stdio(true, Stream.never))),
  )

  it.effect("y: starts only after vibestd reports it gone; running or moved starts nothing", () =>
    Effect.gen(function* () {
      const ok = fake("stopped")
      assert.strictEqual(yield* ok.run, "started")
      assert.deepStrictEqual(ok.calls, ["RunningCoordinator", "StopCoordinator", "start"])
      for (const result of ["running", "moved"] as const) {
        const f = fake(result)
        assert.isTrue(Exit.isFailure(yield* Effect.exit(f.run)), result)
        assert.deepStrictEqual(f.calls, ["RunningCoordinator", "StopCoordinator"], result)
      }
    }).pipe(Effect.provide(stdio(true, typed("y\n")))),
  )
})
