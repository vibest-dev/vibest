import { assert, describe, it } from "@effect/vitest"
import { claimedText } from "@vibest/core/claude-inbox"

describe("Claude inbox claim", () => {
  it("builds a claim body only from ids the claim returned", () => {
    assert.strictEqual(claimedText([{ id: 1, message: "a" }, { id: 2, message: "b" }], [2]), "b")
    assert.strictEqual(claimedText([{ id: 1, message: "a" }, { id: 2, message: "b" }], [1, 2]), ["a", "b"].join("\n\n"))
  })
})
