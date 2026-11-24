import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Sink, Stdio, Stream } from "effect"
import { TestClock } from "effect/testing"

import { resolveRunning, RunningActions } from "../src/commands/handlers/default.ts"

const stdio = (terminal: boolean, stdin: Stream.Stream<Uint8Array>) =>
  Stdio.layerTest({
    stdinIsTerminal: Effect.succeed(terminal),
    stdoutIsTerminal: Effect.succeed(terminal),
    stdin,
    stdout: () => Sink.drain,
  })

const typed = (text: string) => Stream.make(new TextEncoder().encode(text))

const running = {
  sessionId: "sess-1",
  harness: "claude",
  place: "herdr w1:p1",
  runtime: "herdr",
  address: "{}",
}

describe("resolveRunning while the root session runs in another terminal", () => {
  for (const [name, terminal, stdin] of [
    ["Cancel (3)", true, typed("3\n")],
    ["EOF", true, Stream.empty],
    ["not a terminal", false, typed("1\n")],
  ] as const)
    it.effect(`${name}: fails naming where it runs`, () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(resolveRunning(running))
        assert.isTrue(Exit.isFailure(exit))
        assert.include(String(exit), "session sess-1 (claude) runs in herdr w1:p1")
      }).pipe(Effect.provide(stdio(terminal, stdin))),
    )

  it.effect("choice 1 returns Move with the running sessionId", () =>
    Effect.gen(function* () {
      const action = yield* resolveRunning(running)
      assert.deepStrictEqual(action, RunningActions.Move({ sessionId: "sess-1" }))
    }).pipe(Effect.provide(stdio(true, typed("1\n")))),
  )

  it.effect("choice 2 returns New for a parallel conversation", () =>
    Effect.gen(function* () {
      const action = yield* resolveRunning(running)
      assert.deepStrictEqual(action, RunningActions.New())
    }).pipe(Effect.provide(stdio(true, typed("2\n")))),
  )

  it.effect("no answer within two minutes: fails", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(resolveRunning(running)))
      yield* TestClock.adjust("2 minutes")
      assert.isTrue(Exit.isFailure(yield* Fiber.join(fiber)))
    }).pipe(Effect.provide(stdio(true, Stream.never))),
  )
})
