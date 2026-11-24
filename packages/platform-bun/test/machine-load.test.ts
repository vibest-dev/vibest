import { assert, describe, it } from "@effect/vitest"
import { cliHeaders } from "@vibest/client/client"
import { Effect } from "effect"
import { RpcClient } from "effect/rpc"

import * as Platform from "#platform"

import { repoStack } from "./lib/machines-fakes.ts"

describe("Machine.Load", () => {
  it.effect("an execution left open by a session that was archived is not working", () =>
    Effect.gen(function* () {
      const x = yield* repoStack()
      const cli = <A, E, R>(effect: Effect.Effect<A, E, R>) => RpcClient.withHeaders(effect, cliHeaders(x.directory))

      const enter = (harness: string, fresh: boolean) =>
        cli(x.raw["Session.Claim"]({ agent: "coordinator", harness, fresh, terminal: "t1", runtime: "herdr" }))

      const first = yield* enter("cursor", false)
      yield* cli(x.raw.Archive({ id: first.sessionId }))
      yield* enter("pi", true)
      const { executions } = yield* cli(x.raw["Machine.Load"]({}))

      assert.strictEqual(executions.working, 0)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
