import { assert, describe, it } from "@effect/vitest"

import { deliveryText } from "../src/delivery-text.ts"

const agent = (message: string) => ({
  sender: {
    agent: "general",
    title: "Upgrade without stopping agents",
    session: "6b8b00e4-1111-4111-8111-111111111111",
  },
  message,
})

describe("Pi delivery text", () => {
  it("an agent message, a notice, and a user send", () => {
    assert.strictEqual(
      deliveryText([
        agent("Progress: done\nmore"),
        { sender: "vibest", message: "w1 exited." },
        { sender: "user", message: "hello" },
      ]),
      [
        "Message from @General · Upgrade without stopping agents (6b8b00e4)",
        "Progress: done",
        "",
        "Message from Vibest",
        "w1 exited.",
        "",
        "Message from You",
        "hello",
      ].join("\n"),
    )
  })

  it("trims the first line to about 120 characters", () => {
    const lines = deliveryText([agent("x".repeat(200))]).split("\n")
    assert.strictEqual([...lines[1]!].length, 120)
    assert.ok(lines[1]!.endsWith("…"))
  })
})
