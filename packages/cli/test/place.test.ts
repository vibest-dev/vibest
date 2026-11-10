import { assert, describe, it } from "@effect/vitest"
import { placeOf } from "@vibest/server/listing"

describe("place", () => {
  it("reads as the runtime name and the address, or not placed", () => {
    const local = (id: string) => ({ machine: "local", id })
    assert.strictEqual(placeOf({ id: "herdr" }, local("default/w8E:p1Q")), "herdr default/w8E:p1Q")
    assert.strictEqual(placeOf({ id: "herdr" }, local("")), "herdr (not placed)")
    assert.strictEqual(placeOf({ id: "hc", name: "herdr-core" }, local("t1q")), "herdr-core t1q")
    assert.strictEqual(placeOf({ id: "hc", name: "herdr-core" }, local("t1q@mb")), "herdr-core t1q@mb")
    assert.strictEqual(placeOf({ id: "hc", name: "herdr-core" }, local("")), "herdr-core (not placed)")
  })
})
