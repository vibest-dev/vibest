import { assert, describe, it } from "@effect/vitest"
import { Context, Effect } from "effect"

import { Commands } from "../src/commands/commands.ts"
import { Runtime } from "../src/framework/runtime.ts"

class Missing extends Context.Service<Missing, {}>()("test/Missing") {}

const needsMissing = Effect.flatMap(Missing, () => Effect.void)

describe("handler environment", () => {
  it("a handler or loader that needs a service the entry does not provide does not compile", () => {
    const handler = Runtime.handler(
      Commands.commands.status,
      // @ts-expect-error Missing is not in the allowed environment
      () => needsMissing,
    )
    const loader: Runtime.Handlers<typeof Commands.commands.status> = () =>
      // @ts-expect-error Missing is not in the allowed environment
      Promise.resolve({ default: () => needsMissing })
    assert.isFunction(handler)
    assert.isFunction(loader)
  })
})
