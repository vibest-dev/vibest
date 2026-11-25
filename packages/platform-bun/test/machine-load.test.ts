import { assert, describe, it } from "@effect/vitest"
import { cliHeaders } from "@vibest/client/client"
import { withHeaders } from "@vibest/client/unix-http"
import { Effect } from "effect"

import * as Platform from "#platform"

import { repoStack } from "./lib/machines-fakes.ts"

describe("Machine.Load", () => {
  it.effect("an execution left open by a session that was archived is not working", () =>
    Effect.gen(function* () {
      const x = yield* repoStack()
      const cli = <A, E, R>(effect: Effect.Effect<A, E, R>) => withHeaders(effect, cliHeaders(x.directory))

      const enter = (harness: string, fresh: boolean) =>
        cli(
          x.raw["server.session"]["session.claim"]({
            payload: {
              agent: "coordinator",
              harness,
              fresh,
              terminal: { id: "t1" },
              runtime: "herdr",
            },
          }),
        )

      const first = yield* enter("cursor", false)
      yield* cli(x.raw["server.session"]["session.archive"]({ params: { id: first.sessionId }, payload: {} }))
      yield* enter("pi", true)
      const { executions } = yield* cli(x.raw["server.machine"]["machine.load"]({ query: {} }))

      assert.strictEqual(executions.working, 0)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
