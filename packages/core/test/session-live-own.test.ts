import { assert, describe, it } from "@effect/vitest"
import { SessionLive, type Restarted } from "@vibest/core/session/live"
import { Effect, Fiber, Scheduler } from "effect"
import { TestClock } from "effect/testing"

import { interruptOnceReady } from "./lib/interrupt-at.ts"

const restarted: Restarted = { id: "a", projectId: "p", ok: true, message: "restarted" }

describe("SessionLive.restarting.own", () => {
  it.effect("an interrupt at any point of the registration leaves the next restart of that id able to run", () =>
    Effect.gen(function* () {
      for (let op = 1; op <= 30; op++) {
        const live = yield* SessionLive.make
        const counted = { calls: 0 }
        const fiber = yield* Effect.forkChild(
          live.restarting.own("a", Effect.succeed(restarted)).pipe(
            Effect.provideService(
              Scheduler.Scheduler,
              interruptOnceReady(() => ++counted.calls >= op),
            ),
          ),
        )
        yield* Fiber.await(fiber)
        const next = yield* TestClock.withLive(
          live.restarting.own("a", Effect.succeed(restarted)).pipe(Effect.timeoutOption("1 second")),
        )
        assert.isTrue(next._tag === "Some", `a restart of a after an interrupt at boundary ${op} runs`)
      }
    }),
  )
})
