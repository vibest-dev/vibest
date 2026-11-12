import { assert, describe } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { type Candidate, Plugins } from "@vibest/core/plugins"
import { AgentRefused, Plugin } from "@vibest/plugin"
import { Effect, Layer } from "effect"

import { agentsLayer } from "./lib/agents.ts"
import { testEffect } from "./lib/effect.ts"
import { harnessesLayer, runtimesLayer, subscriptionsLayer } from "./lib/harnesses.ts"

const candidate = (id: string, plugin: Plugin.Plugin, options: Record<string, unknown> = {}): Candidate => ({
  source: id,
  revision: "1",
  options,
  plugin,
})

const usableHarnesses = [
  { harness: "pi", available: true },
  { harness: "claude", available: true },
  { harness: "cursor", available: true },
] as const

const start = {
  project: "/r",
  agent: "general",
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
  harnesses: usableHarnesses,
}
const failed = {
  project: "/r",
  agent: "general",
  parentSessionId: undefined,
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  reason: "limited" as const,
  error: "rate_limit",
  input: "p",
  harness: "pi",
  provider: undefined,
  attempts: [],
  harnesses: usableHarnesses,
}

const pluginHost = Layer.provideMerge(
  Layer.provideMerge(
    Layer.provideMerge(Layer.provideMerge(subscriptionsLayer, harnessesLayer()), runtimesLayer),
    Bus.layer,
  ),
  agentsLayer,
)

const it = testEffect(pluginHost)

const run = <A, E, R>(plugins: ReadonlyArray<Candidate>, f: (p: Plugins["Service"]) => Effect.Effect<A, E, R>) =>
  Plugins.make(plugins).pipe(Effect.flatMap(f), Effect.scoped)

describe("plugin host: one event mutated in place in plugin order, refusals and failures always surface, a trace of who changed what", () => {
  it("callbacks mutate one event in place, in plugin order: a later plugin sees and overwrites what an earlier one wrote", () => {
    const seen: Array<string | undefined> = []
    return run(
      [
        candidate(
          "A",
          Plugin.define({
            id: "A",
            effect: (ctx) => ctx.agent.hook("start.before", () => Effect.succeed({ model: "a" })),
          }),
        ),
        candidate(
          "B",
          Plugin.define({
            id: "B",
            effect: (ctx) =>
              ctx.agent.hook("start.before", (e) =>
                Effect.sync(() => {
                  seen.push(e.model)
                  return { model: "b" }
                }),
              ),
          }),
        ),
      ],
      (p) =>
        Effect.gen(function* () {
          const d = yield* p.start({ ...start, harness: "claude", model: "requested" })
          assert.strictEqual(d.model, "b")
          assert.deepStrictEqual(seen, ["a"])
          assert.deepStrictEqual(d.decidedBy, { model: "B" })
          assert.deepStrictEqual(
            d.trace.map((t) => [t.plugin, t.outcome, t.changes]),
            [
              ["A", "ok", [{ field: "model", from: "requested", to: "a" }]],
              ["B", "ok", [{ field: "model", from: "a", to: "b", overwrote: "A" }]],
            ],
          )
        }),
    )
  })

  it("a refusal stops the chain with its reason and the plugin id; later plugins never run", () =>
    run(
      [
        candidate(
          "budget",
          Plugin.define({
            id: "budget",
            effect: (ctx) => ctx.agent.hook("start.before", () => Effect.fail(new AgentRefused({ reason: "no opus" }))),
          }),
        ),
        candidate(
          "after",
          Plugin.define({
            id: "after",
            effect: (ctx) =>
              ctx.agent.hook("start.before", () => Effect.sync(() => assert.fail("must not run after a refusal"))),
          }),
        ),
      ],
      (p) =>
        Effect.gen(function* () {
          const refused = yield* Effect.flip(p.start(start))
          assert.deepInclude(refused, { _tag: "AgentRefused", plugin: "budget", reason: "no opus" })
          assert.deepStrictEqual(
            (yield* p.list).map((q) => [q.id, q.refused, q.calls]),
            [
              ["budget", 1, 1],
              ["after", 0, 0],
            ],
          )
        }),
    ))

  it("a setup plugin answers with a Promise and refuses by throwing AgentRefused", () =>
    run(
      [
        candidate(
          "pick",
          Plugin.define({
            id: "pick",
            setup: (ctx) => ctx.agent.hook("start.before", async () => ({ model: "a" })).then(() => undefined),
          }),
        ),
        candidate(
          "budget",
          Plugin.define({
            id: "budget",
            setup: async (ctx) => {
              await ctx.agent.hook("start.before", (event) => {
                if (event.model === "a") throw new AgentRefused({ reason: "no a" })
              })
            },
          }),
        ),
      ],
      (p) =>
        Effect.gen(function* () {
          const refused = yield* Effect.flip(p.start(start))
          assert.deepInclude(refused, { _tag: "AgentRefused", plugin: "budget", reason: "no a" })
          assert.deepStrictEqual(
            (yield* p.list).map((q) => [q.id, q.changed, q.refused]),
            [
              ["pick", 1, 0],
              ["budget", 0, 1],
            ],
          )
        }),
    ))

  it("a JS throw, or a typed failure that is not AgentRefused, is a refusal in the host's words", () =>
    Effect.gen(function* () {
      yield* run(
        [
          candidate(
            "boom",
            Plugin.define({
              id: "boom",
              effect: (ctx) => ctx.agent.hook("start.before", () => Effect.die(new Error("defect!"))),
            }),
          ),
        ],
        (p) =>
          Effect.gen(function* () {
            const refused = yield* Effect.flip(p.start(start))
            assert.deepInclude(refused, { plugin: "boom", reason: "plugin boom crashed: defect!" })
            assert.strictEqual((yield* p.list).find((q) => q.id === "boom")!.crashed, 1)
          }),
      )
      yield* run(
        [
          candidate(
            "nope",
            Plugin.define({
              id: "nope",
              effect: (ctx) => ctx.agent.hook("start.before", () => Effect.fail(new Error("bad option") as never)),
            }),
          ),
        ],
        (p) =>
          Effect.gen(function* () {
            const refused = yield* Effect.flip(p.start(start))
            assert.deepInclude(refused, { plugin: "nope", reason: "plugin nope crashed: bad option" })
          }),
      )
    }))

  it("a crash in agent.fail fails the operation instead of moving", () =>
    run(
      [
        candidate(
          "mover",
          Plugin.define({
            id: "mover",
            effect: (ctx) => ctx.agent.hook("fail", () => Effect.die("moved?")),
          }),
        ),
      ],
      (p) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(p.fail(failed))
          assert.deepInclude(error, { _tag: "HookFailed", message: "plugin mover crashed: moved?" })
          assert.strictEqual((yield* p.list).find((q) => q.id === "mover")!.crashed, 1)
        }),
    ))
})
