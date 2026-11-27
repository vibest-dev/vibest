import { assert, describe, it } from "@effect/vitest"
import { definitionIn } from "@vibest/core/agent/launch"
import { Agents } from "@vibest/core/agent/registry"
import { Effect } from "effect"

const builtin = { id: "general", description: "builtin", system: "builtin prompt" }

describe("agent registry", () => {
  it.effect("an invalid definition masks the earlier one of its id until a later plugin adds it again", () =>
    Effect.gen(function* () {
      const agents = yield* Agents.make
      yield* agents.transformFor("builtin")((editor) => editor.add(builtin))
      yield* agents.transformFor("files")((editor) =>
        editor.invalid({ id: "general", source: "/agents/general.md", error: "unknown key colour" }),
      )
      const refused = yield* Effect.flip(definitionIn(agents, "general"))
      assert.include(refused.message, "general is invalid: /agents/general.md: unknown key colour")
      yield* agents.transformFor("later")((editor) => editor.add({ ...builtin, system: "later prompt" }))
      assert.strictEqual(agents.find("general")?.system, "later prompt")
    }).pipe(Effect.scoped),
  )
})
