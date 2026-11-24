import { assert, describe, it } from "@effect/vitest"
import { Agents } from "@vibest/core/agents"
import { type Candidate, makeHost } from "@vibest/core/plugin"
import { Hooks } from "@vibest/core/plugin/hooks"
import { type SessionStartBefore, Plugin } from "@vibest/plugin/effect"
import { Duration, Deferred, Effect, Fiber, type Schema } from "effect"
import { TestClock } from "effect/testing"

import { runtimesLayer, subscriptionsLayer, harnessesLayer } from "./lib/harnesses.ts"
import { memoryPluginHost } from "./platform/bun.ts"

const candidate = (
  source: string,
  revision: string,
  plugin: Candidate["plugin"],
  options: Schema.JsonObject = {},
): Candidate => ({ source, revision, options, plugin })

const event = {
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
  harnesses: [
    { harness: "pi", available: true },
    { harness: "claude", available: true },
    { harness: "cursor", available: true },
  ],
}

const host = <A, E>(
  f: (host: Effect.Success<ReturnType<typeof makeHost>>) => Effect.Effect<A, E>,
  timeout?: Duration.Input,
) =>
  makeHost(timeout === undefined ? {} : { timeout }).pipe(
    Effect.flatMap(f),
    Effect.scoped,
    Effect.provide(subscriptionsLayer),
    Effect.provide(harnessesLayer()),
    Effect.provide(runtimesLayer),
    Effect.provide(Agents.layer),
    Effect.provide(memoryPluginHost),
    Effect.provide(Hooks.layer),
  )

describe("plugins: hook events are detached copies", () => {
  const hooked = (id: string, callback: (e: SessionStartBefore) => Effect.Effect<void>) =>
    candidate(id, "1", Plugin.define({ id, effect: (ctx) => ctx.session.hook("start.before", callback) }))

  it.effect("a reference a plugin keeps cannot change the result or the trace after its callback succeeded", () =>
    host((h) =>
      Effect.gen(function* () {
        const kept: Array<{ id: string }> = []
        yield* h.activate([
          hooked("keeper", (e) =>
            Effect.sync(() => {
              const machine = { id: "chosen" }
              kept.push(machine)
              e.machine = machine
            }),
          ),
        ])
        const decision = yield* h.service.start(event)
        kept.at(-1)!.id = "changed later"
        assert.strictEqual(decision.machine.id, "chosen")
        assert.deepStrictEqual(decision.trace[0]!.changes[0]!.to, { id: "chosen" })
      }),
    ),
  )

  it.effect("writes to nested data before a failure and before and after a timeout never reach the input", () =>
    host(
      (h) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          const input = structuredClone(event)
          const late: Array<() => void> = []
          yield* h.activate([
            hooked("crash", (e) =>
              Effect.sync(() => void Object.assign(e.harnesses[0]!, { available: false })).pipe(
                Effect.andThen(Effect.die("boom")),
              ),
            ),
          ])
          assert.strictEqual((yield* h.service.start(input).pipe(Effect.flip))._tag, "SessionRefused")
          assert.deepStrictEqual(input, event)
          yield* h.activate([
            hooked("timeout", (e) =>
              Effect.sync(() => {
                Object.assign(e.harnesses[1]!, { available: false })
                late.push(() => void Object.assign(e.harnesses[2]!, { available: false }))
              }).pipe(Effect.andThen(Deferred.await(gate))),
            ),
          ])
          const starting = yield* Effect.forkChild(h.service.start(input).pipe(Effect.flip))
          yield* TestClock.adjust("20 millis")
          assert.strictEqual((yield* Fiber.join(starting))._tag, "SessionRefused")
          late.at(-1)!()
          assert.deepStrictEqual(input, event)
        }),
      "20 millis",
    ),
  )
})

describe("plugins: one registry across activations", () => {
  const modelOf = (id: string, model: string, setup: Effect.Effect<void, never, never> = Effect.void) =>
    Plugin.define({
      id,
      effect: (ctx) =>
        setup.pipe(Effect.andThen(ctx.session.hook("start.before", (e) => Effect.sync(() => void (e.model = model))))),
    })

  it.effect("a retired revision whose teardown overran its deadline leaves no hook beside its replacement", () =>
    host((h) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()

        const stuck = Plugin.define({
          id: "g",
          effect: (ctx) =>
            ctx.session
              .hook("start.before", (e) => Effect.sync(() => void (e.model = "retired")))
              .pipe(Effect.andThen(Effect.addFinalizer(() => Deferred.await(gate)))),
        })

        yield* h.activate([candidate("g", "1", stuck)])
        const reloading = yield* Effect.forkChild(h.activate([candidate("g", "2", modelOf("g", "current"))]))
        yield* TestClock.adjust("5 seconds")
        yield* Fiber.join(reloading)
        const decision = yield* h.service.start(event)
        assert.deepStrictEqual(
          decision.trace.map((t) => t.plugin),
          ["g"],
        )
        assert.strictEqual(decision.model, "current")
        yield* Deferred.succeed(gate, undefined)
      }),
    ),
  )

  it.effect("a hook registered late runs in its plugin's load order, not in registration order", () =>
    host((h) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()

        const late = Plugin.define({
          id: "a",
          effect: (ctx) =>
            Deferred.await(gate).pipe(
              Effect.andThen(ctx.session.hook("start.before", (e) => Effect.sync(() => void (e.model = "a")))),
              Effect.forkScoped,
              Effect.asVoid,
            ),
        })

        yield* h.activate([candidate("a", "1", late), candidate("b", "1", modelOf("b", "b"))])
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.yieldNow
        const decision = yield* h.service.start(event)
        assert.deepStrictEqual(
          decision.trace.map((t) => t.plugin),
          ["a", "b"],
        )
        assert.strictEqual(decision.model, "b")
      }),
    ),
  )
})
