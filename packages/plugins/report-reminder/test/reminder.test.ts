import { assert, describe, it } from "@effect/vitest"
import type { Context } from "@vibest/plugin/effect"
import { Effect, Stream } from "effect"

import reminder from "../src/index.ts"

const S = "33333333-3333-4333-8333-333333333333"
const E = "22222222-2222-4222-8222-222222222222"

const ended = (execution: number) => ({
  aggregate: S,
  seq: execution + 1,
  at: 0,
  sessionId: S,
  type: "execution.ended",
  data: { execution, outcome: "completed" },
})

const sentFrom = (execution: number) => ({
  aggregate: E,
  seq: execution,
  at: 0,
  sessionId: E,
  type: "inbox.queued",
  data: { kind: "send", sender: { session: S }, content: "x", status: "pending", execution },
})

describe("vibest.report-reminder", () => {
  it.live("judges each live end by its own execution even when the session has moved on", () =>
    Effect.gen(function* () {
      const requests: Array<string> = []

      const registration = { dispose: Effect.void }

      const ctx: Context = {
        options: {},
        agent: { hook: () => Effect.succeed(registration), transform: () => Effect.succeed(registration) },
        machine: { hook: () => Effect.succeed(registration) },
        runtime: { transform: () => Effect.succeed(registration) },
        harness: { transform: () => Effect.succeed(registration) },
        subscription: { report: () => Effect.void },
        event: { subscribe: () => Stream.fromIterable([ended(4), sentFrom(6), ended(6), ended(8)]) as never },
        session: {
          list: () => Effect.succeed([]),
          get: () =>
            Effect.succeed({
              id: S,
              title: "sub",
              parentId: E,
              status: "idle",
              latest: { execution: 8, outcome: "completed", sent: 0, endedAt: 0 },
            }),
          send: (input) => Effect.sync(() => void requests.push(input.request ?? "")),
        },
      }

      yield* reminder.effect(ctx)
      yield* Effect.sleep("50 millis")

      assert.deepStrictEqual(requests, [`vibest.report-reminder:${S}:4`, `vibest.report-reminder:${S}:8`])
    }).pipe(Effect.scoped),
  )
})
