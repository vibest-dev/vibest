// The default harness choice (architecture.md §9), run through the plugin host as the product loads it: first.
import { assert, describe, it } from "@effect/vitest"
import { type Candidate, Plugins } from "@vibest/core/plugins"
import { Runtimes } from "@vibest/core/runtimes"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { Effect } from "effect"

import { harnessChoice } from "../src/index.ts"

/** Fake preflight output: every harness usable, in HARNESS_IDS order. */
const harnesses = [
  { harness: "pi", available: true },
  { harness: "claude", available: true },
  { harness: "cursor", available: true },
] as const

const start = {
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
}

const run = <A, E, R>(plugins: ReadonlyArray<Candidate>, f: (p: Plugins["Service"]) => Effect.Effect<A, E, R>) =>
  Plugins.make([harnessChoice, ...plugins]).pipe(
    Effect.flatMap(f),
    Effect.scoped,
    Effect.provide(Subscriptions.layer),
    Effect.provide(Runtimes.layer),
  )

describe("harness choice", () => {
  it.effect("no user plugins: the choice keeps a usable preference and decides nothing else", () =>
    run([], (p) =>
      Effect.gen(function* () {
        const d = yield* p.start({ ...start, harness: "claude", model: "m" })
        assert.deepStrictEqual([d.harness, d.model, d.decidedBy], ["claude", "m", {}])
        assert.deepStrictEqual(
          d.trace.map((t) => [t.plugin, t.outcome, t.changes]),
          [["harness-choice", "ok", []]],
        )
      }),
    ),
  )

  it.effect("rerouting off a limited harness drops the model named for it", () =>
    run([], (p) =>
      Effect.gen(function* () {
        const limited = { window: "5h", percent: 100, status: "limited" as const, resetTime: null }
        yield* (yield* Subscriptions).report({ harness: "claude", limits: [limited] })
        // A model the new harness does not list would fail preflight: the reroute starts on the new harness's default.
        const d = yield* p.start({ ...start, harness: "claude", model: "claude-opus-5-5" })
        assert.strictEqual(d.harness, "pi")
        assert.strictEqual(d.model, undefined)
        assert.deepStrictEqual(d.decidedBy, { harness: "harness-choice", model: "harness-choice" })
      }),
    ),
  )
})
