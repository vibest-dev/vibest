import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { type Candidate, Plugins } from "@vibest/core/plugins"
import { Runtimes } from "@vibest/core/runtimes"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { AgentRefused, Plugin } from "@vibest/plugin"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import glmOnly from "../../../packages/plugin/examples/glm-only.ts"
import { harnessChoice } from "./fakes.ts"

const candidate = (id: string, plugin: Plugin.Plugin, options: Record<string, unknown> = {}): Candidate => ({
  source: id,
  revision: "1",
  options,
  plugin,
})

const preflightEveryHarnessUsableInHarnessIdsOrder = [
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
  harnesses: preflightEveryHarnessUsableInHarnessIdsOrder,
}
const failed = {
  project: "/r",
  agentType: "general",
  parentSessionId: undefined,
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  reason: "limited" as const,
  error: "rate_limit",
  turn: "p",
  harness: "pi",
  provider: undefined,
  attempts: [],
  harnesses: preflightEveryHarnessUsableInHarnessIdsOrder,
}

const run = <A, E, R>(plugins: ReadonlyArray<Candidate>, f: (p: Plugins["Service"]) => Effect.Effect<A, E, R>) =>
  Plugins.make([harnessChoice, ...plugins]).pipe(
    Effect.flatMap(f),
    Effect.scoped,
    Effect.provide(Subscriptions.layer),
    Effect.provide(Runtimes.layer),
    Effect.provide(Bus.layer),
  )

describe("plugin host: one event mutated in place in plugin order, refusals and failures always surface, a trace of who changed what", () => {
  it.effect(
    "callbacks mutate one event in place, in plugin order: a later plugin sees and overwrites what an earlier one wrote",
    () => {
      const seen: Array<string | undefined> = []
      return run(
        [
          candidate(
            "A",
            Plugin.define({
              id: "A",
              effect: (ctx) => ctx.agent.hook("start.before", (e) => Effect.sync(() => (e.model = "a"))),
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
                    e.model = "b"
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
                ["harness-choice", "ok", []],
                ["A", "ok", [{ field: "model", from: "requested", to: "a" }]],
                ["B", "ok", [{ field: "model", from: "a", to: "b", overwrote: "A" }]],
              ],
            )
          }),
      )
    },
  )

  it.effect("a refusal stops the chain with its reason and the plugin id; later plugins never run", () =>
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
              ["harness-choice", 0, 1],
              ["budget", 1, 1],
              ["after", 0, 0],
            ],
          )
        }),
    ),
  )

  it.effect("a JS throw is a refusal too, in the host's words", () =>
    run(
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
    ),
  )

  it.effect("a typed failure that is not AgentRefused is a crash", () =>
    run(
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
    ),
  )

  it.effect("a timeout in agent.start.before refuses the start", () => {
    let entered = false
    return run(
      [
        candidate(
          "stuck",
          Plugin.define({
            id: "stuck",
            effect: (ctx) =>
              ctx.agent.hook("start.before", () =>
                Effect.sync(() => (entered = true)).pipe(Effect.andThen(Effect.sleep("1 hour"))),
              ),
          }),
        ),
      ],
      (p) =>
        Effect.gen(function* () {
          const spawning = yield* Effect.forkChild(p.start(start))
          yield* Effect.gen(function* () {
            while (!entered) yield* TestClock.withLive(Effect.sleep("10 millis"))
          })
          yield* TestClock.adjust("5 seconds")
          const refused = yield* Effect.flip(Fiber.join(spawning))
          assert.deepInclude(refused, { plugin: "stuck", reason: "plugin stuck timed out after 5s" })
          yield* TestClock.adjust("1 hour")
        }),
    )
  })

  it.effect("a crash in agent.fail fails the operation instead of moving", () =>
    run(
      [
        candidate(
          "mover",
          Plugin.define({
            id: "mover",
            effect: (ctx) =>
              ctx.agent.hook("fail", (e) =>
                Effect.sync(() => (e.move = { harness: "claude" })).pipe(Effect.andThen(Effect.die("moved?"))),
              ),
          }),
        ),
      ],
      (p) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(p.fail(failed))
          assert.deepInclude(error, { _tag: "HookFailed", message: "plugin mover crashed: moved?" })
          assert.strictEqual((yield* p.list).find((q) => q.id === "mover")!.crashed, 1)
        }),
    ),
  )

  it.effect("a timeout in agent.fail fails the operation", () => {
    let entered = false
    return run(
      [
        candidate(
          "hang",
          Plugin.define({
            id: "hang",
            effect: (ctx) =>
              ctx.agent.hook("fail", () => Effect.sync(() => (entered = true)).pipe(Effect.andThen(Effect.never))),
          }),
        ),
      ],
      (p) =>
        Effect.gen(function* () {
          const asking = yield* Effect.forkChild(p.fail(failed))
          yield* Effect.gen(function* () {
            while (!entered) yield* TestClock.withLive(Effect.sleep("10 millis"))
          })
          yield* TestClock.adjust("5 seconds")
          const error = yield* Effect.flip(Fiber.join(asking))
          assert.include(error.message, "plugin hang timed out after 5s")
          yield* TestClock.adjust("1 minute")
        }),
    )
  })

  it.effect("agent.fail: the last plugin to write move decides, and the trace says so", () =>
    run(
      [
        candidate(
          "first",
          Plugin.define({
            id: "first",
            effect: (ctx) => ctx.agent.hook("fail", (e) => Effect.sync(() => (e.move = { harness: "cursor" }))),
          }),
        ),
        candidate(
          "last",
          Plugin.define({
            id: "last",
            effect: (ctx) =>
              ctx.agent.hook("fail", (e) => Effect.sync(() => (e.move = { harness: "claude", provider: "anthropic" }))),
          }),
        ),
      ],
      (p) =>
        Effect.gen(function* () {
          const moved = yield* p.fail(failed)
          assert.deepStrictEqual(moved.move, { harness: "claude", provider: "anthropic" })
          assert.deepStrictEqual(
            moved.trace.map((t) => [t.plugin, t.outcome, t.changes]),
            [
              ["harness-choice", "ok", [{ field: "move", to: { harness: "claude", provider: undefined } }]],
              [
                "first",
                "ok",
                [
                  {
                    field: "move",
                    from: { harness: "claude", provider: undefined },
                    to: { harness: "cursor" },
                    overwrote: "harness-choice",
                  },
                ],
              ],
              [
                "last",
                "ok",
                [
                  {
                    field: "move",
                    from: { harness: "cursor" },
                    to: { harness: "claude", provider: "anthropic" },
                    overwrote: "first",
                  },
                ],
              ],
            ],
          )
        }),
    ),
  )

  it.effect("glm-only: subagents run on Pi with its provider and model; the main agent keeps its harness", () =>
    run([candidate("glm-only", glmOnly, { provider: "zai", model: "glm-5.3" })], (p) =>
      Effect.gen(function* () {
        const s = yield* p.start({ ...start, harness: "claude" })
        assert.deepStrictEqual([s.harness, s.provider, s.model], ["pi", "zai", "glm-5.3"])
        assert.deepStrictEqual(s.decidedBy, { harness: "glm-only", provider: "glm-only", model: "glm-only" })
        const m = yield* p.start({ ...start, agentType: "main", harness: "claude" })
        assert.deepStrictEqual([m.harness, m.provider, m.model], ["claude", undefined, undefined])
      }),
    ),
  )
})
