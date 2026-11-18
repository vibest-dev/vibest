import { assert, it } from "@effect/vitest"
import { channelOf, newestIn } from "@vibest/client/release"

it("a stable vibest follows the newest stable release; a beta follows the newest release of either channel", () => {
  const released = ["0.1.0-beta.3", "0.1.0", "0.2.0-beta.1", "0.2.0-beta.10", "0.0.9", "junk"]
  assert.strictEqual(newestIn("stable", released), "0.1.0")
  assert.strictEqual(newestIn("beta", released), "0.2.0-beta.10")
  assert.strictEqual(newestIn("beta", ["0.1.0-beta.3", "0.1.0"]), "0.1.0")
  assert.isUndefined(newestIn("stable", ["0.0.1-beta.19"]))
  assert.strictEqual(channelOf("0.1.0"), "stable")
  assert.strictEqual(channelOf("0.1.0-beta.3"), "beta")
  assert.strictEqual(channelOf("0.0.2-dev"), "beta")
})
