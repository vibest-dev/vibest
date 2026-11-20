import { assert, describe, it } from "@effect/vitest"

import { deliveryText } from "../src/delivery-text.ts"

const agent = (message: string) => ({
  sender: {
    type: "agent" as const,
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
        { sender: { type: "vibest" }, message: "w1 exited." },
        { sender: { type: "user" }, message: "hello" },
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

  it("a plugin message names the plugin", () => {
    assert.strictEqual(
      deliveryText([
        { sender: { type: "plugin", plugin: "vibest.report-reminder" }, message: "w1 ended without a message" },
      ]),
      "Message from Vibest · vibest.report-reminder\nw1 ended without a message",
    )
  })

  it("a remote send shows the agent, the title and the machine", () => {
    assert.strictEqual(
      deliveryText([
        {
          sender: { type: "agent", agent: "general", title: "Ask me", session: "aaaaaaaa", machine: "mb" },
          message: "report",
        },
      ]).split("\n")[0],
      "Message from @General · Ask me (mb/aaaaaaaa)",
    )
  })

  it("a remote sender without an agent shows the machine only", () => {
    const lines = deliveryText([
      { sender: { type: "agent", session: "aaaaaaaa", machine: "mb" }, message: "report" },
    ]).split("\n")

    assert.strictEqual(lines[0], "Message from @Mb · (mb/aaaaaaaa)")
    assert.strictEqual(lines[1], "report")
  })

  it("trims the first line to about 120 characters", () => {
    const lines = deliveryText([agent("x".repeat(200))]).split("\n")
    assert.strictEqual([...lines[1]!].length, 120)
    assert.ok(lines[1]!.endsWith("…"))
  })
})
