// The default harness choice (architecture.md §9), run against its own hooks: a fake context records what it
// registers, and each test calls the hook on an event the way vibestd's plugin host does (one event, mutated in place).
import { assert, describe, it } from "@effect/vitest"
import type { AgentStartBefore, Context, SubscriptionSnapshot } from "@vibest/plugin"
import { Effect } from "effect"

import { harnessChoicePlugin } from "../src/index.ts"

type StartHook = (event: AgentStartBefore) => Effect.Effect<void, unknown>

/** The plugin's `start.before` callback, set up in a scope of its own. */
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

/** Fake preflight output: every harness usable, in HARNESS_IDS order. */
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

const limitedClaude: SubscriptionSnapshot = {
  harness: "claude",
  provider: "",
  machine: "local",
  account: { kind: "subscription" },
  limits: [{ window: "5h", percent: 100, status: "limited", resetTime: null }],
  updatedAt: 0,
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

  it.effect("rerouting off a limited harness drops the model named for it", () =>
    Effect.gen(function* () {
      const hook = yield* startHook
      // A model the new harness does not list would fail preflight: the reroute starts on the new harness's default.
      const event = start({ harness: "claude", model: "claude-opus-5-5", subscriptions: [limitedClaude] })
      yield* hook(event)
      assert.strictEqual(event.harness, "pi")
      assert.strictEqual(event.model, undefined)
    }).pipe(Effect.scoped),
  )
})
