// Against the running herdr. Skipped unless HERDR_LIVE is set and this runs inside a herdr pane.
import { assert, it } from "@effect/vitest"
import { HerdrPool } from "@vibest/runtime-herdr/pool"
import { Config, Effect, Layer, Option } from "effect"

import * as Platform from "#platform"

// Deciding whether to register the test happens at collection time, before any test fiber exists.
const socketPath = await Effect.runPromise(
  Config.all([Config.String("HERDR_LIVE"), Config.String("HERDR_SOCKET_PATH")]).pipe(
    Config.map(([, socket]) => socket),
    Config.option,
    Effect.map(Option.getOrUndefined),
  ),
)

it.live.skipIf(!socketPath)("resolve the current socket to its session name, then call it", () =>
  Effect.gen(function* () {
    const pool = yield* HerdrPool
    const session = yield* pool.resolve({ socketPath: socketPath! })
    const pong = yield* (yield* pool.client(session)).call("ping", {})
    assert.strictEqual(pong.type, "pong")
  }).pipe(Effect.provide(HerdrPool.layer.pipe(Layer.provide(Platform.services)))),
)
