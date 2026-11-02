// `vibest` starting the main agent while the project's main agent runs in another terminal: it fails naming where,
// asks nothing, and starts nothing (no Project.CoordinatorSession, no exec).
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"

import { soleMainAgent } from "../src/cli.ts"

/** A client whose main agent runs in `place` (none: null); `start` stands for CoordinatorSession and exec. */
const fake = (place: string | undefined) => {
  const calls: Array<string> = []
  const client = {
    "Project.RunningCoordinator": () =>
      Effect.sync(() => {
        calls.push("RunningCoordinator")
        return place === undefined ? null : { harness: "claude" as const, place, runtime: "herdr", address: "{}" }
      }),
  } as unknown as Parameters<typeof soleMainAgent>[0]
  const start = Effect.sync(() => {
    calls.push("start")
    return "started"
  })
  return { calls, run: soleMainAgent(client, "test/p2", start) }
}

describe("soleMainAgent", () => {
  it.effect("a main agent running elsewhere: fails naming where and to exit it first, starts nothing", () =>
    Effect.gen(function* () {
      const f = fake("herdr pane w1:p1")
      const exit = yield* Effect.exit(f.run)
      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(exit), "the main agent (claude) is still running in herdr pane w1:p1")
      assert.include(String(exit), "Exit it there first")
      assert.deepStrictEqual(f.calls, ["RunningCoordinator"])
    }),
  )

  it.effect("none running elsewhere: starts", () =>
    Effect.gen(function* () {
      const f = fake(undefined)
      assert.strictEqual(yield* f.run, "started")
      assert.deepStrictEqual(f.calls, ["RunningCoordinator", "start"])
    }),
  )
})
