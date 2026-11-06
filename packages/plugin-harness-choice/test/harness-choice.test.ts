import { assert, describe, it } from "@effect/vitest"
import type { AgentStartBefore, Context, SubscriptionSnapshot } from "@vibest/plugin"
import { Effect } from "effect"

import { harnessChoicePlugin } from "../src/index.ts"

type StartHook = (event: AgentStartBefore) => Effect.Effect<void, unknown>

const startHook = Effect.gen(function* () {
  let hook: StartHook | undefined
  const context = {
    agent: {
      hook: (name: string, callback: StartHook) =>
        Effect.sync(() => {
          if (name === "start.before") hook = callback
        }),
    },
  } as unknown as Context
  yield* harnessChoicePlugin.effect(context)
  if (hook === undefined) return yield* Effect.die("harness-choice registered no start.before hook")
  return hook
})

const harnesses = [
  { harness: "pi", available: true },
  { harness: "claude", available: true },
  { harness: "cursor", available: true },
] as const

const start = (overrides: Partial<AgentStartBefore>): AgentStartBefore => ({
  project: "/r",
  agentType: "general",
  parentSessionId: undefined,
  prompt: "p",
  harness: undefined,
  provider: undefined,
  model: undefined,
  machine: { id: "local" },
  runtime: undefined,
  parentRuntime: undefined,
  machines: [],
  attempts: [],
  harnesses,
  subscriptions: [],
  ...overrides,
})

const resetTime = Date.parse("2099-01-01T00:00:00.000Z")

const limitedCursor: SubscriptionSnapshot = {
  harness: "cursor",
  provider: "",
  machine: "local",
  account: { kind: "subscription" },
  limits: [{ window: "monthly", percent: 100, status: "limited", resetTime }],
  updatedAt: 0,
}

const reasonOf = (error: unknown) => {
  assert.deepInclude(error as { _tag: string }, { _tag: "AgentRefused" })
  return (error as { reason: string }).reason
}

describe("harness choice", () => {
  it.effect("keeps a usable preference and decides nothing else", () =>
    Effect.gen(function* () {
      const hook = yield* startHook
      const event = start({ harness: "claude", model: "m" })
      yield* hook(event)
      assert.deepStrictEqual([event.harness, event.provider, event.model], ["claude", undefined, "m"])
    }).pipe(Effect.scoped),
  )

  it.effect("an explicit unavailable harness fails with its reason and starts nothing", () =>
    Effect.gen(function* () {
      const hook = yield* startHook
      const event = start({
        harness: "cursor",
        model: "composer",
        harnesses: [
          { harness: "pi", available: true },
          { harness: "claude", available: true },
          { harness: "cursor", available: false, problem: "cursor model discovery failed: Not logged in" },
        ],
      })
      const reason = reasonOf(yield* Effect.flip(hook(event)))
      assert.strictEqual(reason, "cursor: cursor model discovery failed: Not logged in")
      assert.deepStrictEqual([event.harness, event.provider, event.model], ["cursor", undefined, "composer"])
    }).pipe(Effect.scoped),
  )

  it.effect("an explicit harness is not refused when its limit reset has passed", () =>
    Effect.gen(function* () {
      const hook = yield* startHook
      const event = start({
        harness: "cursor",
        model: "composer",
        subscriptions: [
          {
            ...limitedCursor,
            limits: [{ window: "monthly", percent: 100, status: "limited", resetTime: Date.now() - 1_000 }],
          },
        ],
      })
      yield* hook(event)
      assert.deepStrictEqual([event.harness, event.model], ["cursor", "composer"])
    }).pipe(Effect.scoped),
  )

  it.effect("an explicit limited harness fails with the limit", () =>
    Effect.gen(function* () {
      const hook = yield* startHook
      const event = start({ harness: "cursor", model: "composer", subscriptions: [limitedCursor] })
      const reason = reasonOf(yield* Effect.flip(hook(event)))
      assert.strictEqual(reason, `cursor: monthly limit exhausted, resets ${new Date(resetTime).toISOString()}`)
      assert.deepStrictEqual([event.harness, event.provider, event.model], ["cursor", undefined, "composer"])
    }).pipe(Effect.scoped),
  )

  it.effect("auto still picks an available harness", () =>
    Effect.gen(function* () {
      const hook = yield* startHook
      const event = start({ subscriptions: [limitedCursor] })
      yield* hook(event)
      assert.strictEqual(event.harness, "pi")
    }).pipe(Effect.scoped),
  )
})
