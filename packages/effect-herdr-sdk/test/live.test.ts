// Against the running herdr (needs HERDR_SOCKET_PATH or herdr's default socket). Skipped when HERDR_LIVE is unset.
import { assert, describe, layer } from "@effect/vitest"
import { Config, Effect, Fiber, Layer, Option, Stream } from "effect"
import * as HerdrBun from "../src/bun.js"
import { Herdr, HerdrError } from "../src/index.js"

// Deciding whether to register the tests happens at collection time, before any test fiber exists.
const enabled = await Effect.runPromise(Config.option(Config.String("HERDR_LIVE")).pipe(Effect.map(Option.isSome)))

describe.skipIf(!enabled)("live", () =>
  layer(Herdr.layer().pipe(Layer.provide(HerdrBun.layer)), { excludeTestServices: true })("herdr live", (it) => {
    it.effect("the running herdr speaks the protocol these types were generated for", () =>
      Effect.gen(function* () {
        yield* Herdr.verifyProtocol(yield* Herdr)
      }))

    it.effect("ping", () =>
      Effect.gen(function* () {
        const r = yield* (yield* Herdr).call("ping", {})
        assert.strictEqual(r.type, "pong")
        assert.strictEqual(r.protocol, 22)
      }))

    it.effect("server error is a HerdrError", () =>
      Effect.gen(function* () {
        const e = yield* Effect.flip((yield* Herdr).call("agent.get", { target: "no-such-agent-xyz" }))
        assert.instanceOf(e, HerdrError)
      }))

    it.effect("broadcast subscription acks and can be closed", () =>
      Effect.gen(function* () {
        const h = yield* Herdr
        const frames = yield* h.subscribe([{ type: "pane.updated" }, { type: "pane.closed" }]).pipe(
          Stream.take(1),
          Stream.timeout("1500 millis"),
          Stream.runCollect,
        )
        assert.isTrue(Array.isArray(frames))
      }))

    it.effect("per-pane subscription without pane_id is rejected by herdr", () =>
      Effect.gen(function* () {
        // The types already forbid this; the test pins down that herdr refuses it too (SPEC §6.2).
        const e = yield* Effect.flip(
          // @ts-expect-error pane.agent_status_changed requires pane_id
          (yield* Herdr).subscribe([{ type: "pane.agent_status_changed" }]).pipe(Stream.runHead),
        )
        assert.instanceOf(e, HerdrError)
      }))

    it.effect("a per-pane subscription pushes that pane's agent status changes", () =>
      Effect.gen(function* () {
        const h = yield* Herdr
        // A throwaway pane beside this one, closed afterwards.
        const pane = yield* Effect.acquireRelease(
          h.call("pane.split", { direction: "down", focus: false }).pipe(Effect.map((r) => r.pane.pane_id)),
          (paneId) => h.call("pane.close", { pane_id: paneId }).pipe(Effect.ignore),
        )
        const pushed = yield* h.subscribe([{ type: "pane.agent_status_changed", pane_id: pane }]).pipe(
          Stream.take(1),
          Stream.timeout("3 seconds"),
          Stream.runCollect,
          Effect.forkChild,
        )
        yield* Effect.sleep("300 millis")
        yield* h.call("pane.report_agent", { pane_id: pane, agent: "pi", source: "effect-herdr-sdk-test", state: "working" })
        const frames = yield* Fiber.join(pushed)
        assert.strictEqual(frames.length, 1)
        assert.deepInclude(frames[0]!.data, { pane_id: pane, agent_status: "working" })
      }).pipe(Effect.scoped))
  }))
