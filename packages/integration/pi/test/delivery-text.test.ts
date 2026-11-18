import { assert, describe, it } from "@effect/vitest"

import { deliveryText } from "../src/delivery-text.ts"

const agent = (agent: string, title: string, session: string, preview: string) => ({
  sender: { agent, title, session },
  preview,
})

describe("Pi delivery text", () => {
  it("an agent message, a notice, and one block per sender", () => {
    assert.strictEqual(
      deliveryText([
        agent("general", "Upgrade without stopping agents", "6b8b00e4-1111-4111-8111-111111111111", "Progress: done"),
        { sender: "vibest", preview: "w1 exited." },
      ]),
      [
        "Message from @General · Upgrade without stopping agents (6b8b00e4)",
        "Progress: done",
        "",
        "Message from Vibest",
        "w1 exited.",
      ].join("\n"),
    )
  })
})
