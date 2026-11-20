import { assert, describe, it } from "@effect/vitest"
import type { Context } from "@vibest/plugin/effect"
import { Effect, Stream } from "effect"

import reminder from "../src/index.ts"

const S = "33333333-3333-4333-8333-333333333333"
const E = "22222222-2222-4222-8222-222222222222"

const ended = (execution: number, outcome: "completed" | "failed") => ({
  aggregate: S,
  seq: execution + 1,
  at: 0,
  sessionId: S,
  type: "execution.ended",
  data: { execution, outcome },
})

describe("vibest.report-reminder", () => {
  it.live(
    "activated while execution 4 runs after it sent, then given the ends of 4, 6 and 8 with the session already at 8: reminds only for 6, which completed and sent nothing",
    () =>
      Effect.gen(function* () {
        const requests: Array<string> = []

        const stored = new Map([
          [4, 1],
          [6, 0],
          [8, 0],
        ])

        const registration = { dispose: Effect.void }

        const ctx: Context = {
          options: {},
          agent: { hook: () => Effect.succeed(registration), transform: () => Effect.succeed(registration) },
          machine: { hook: () => Effect.succeed(registration) },
          runtime: { transform: () => Effect.succeed(registration) },
          harness: { transform: () => Effect.succeed(registration) },
          subscription: { report: () => Effect.void },
          event: {
            subscribe: () =>
              Stream.fromIterable([ended(4, "completed"), ended(6, "completed"), ended(8, "failed")]) as never,
          },
          session: {
            list: () => Effect.succeed([]),
            get: () =>
              Effect.succeed({
                id: S,
                title: "sub",
                parentId: E,
                status: "idle",
                latest: { execution: 8, outcome: "failed", sent: 0, endedAt: 0 },
              }),
            sentIn: (_, execution) => Effect.succeed(stored.get(execution) ?? 0),
            send: (input) => Effect.sync(() => void requests.push(input.request ?? "")),
          },
        }

        yield* reminder.effect(ctx)
        yield* Effect.sleep("50 millis")

        assert.deepStrictEqual(requests, [`vibest.report-reminder:${S}:6`])
      }).pipe(Effect.scoped),
  )
})
