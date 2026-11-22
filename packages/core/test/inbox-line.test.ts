import { assert, describe, it } from "@effect/vitest"
import { detailOf, noticeEnvelope, sessionEnvelope } from "@vibest/core/replies"
import type { Sender } from "@vibest/schema/event"

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const alpha: Sender = { type: "agent", session: A, agent: "general", title: "Alpha" }

const row = (message: string, sender: Sender) => ({ sender, message })

describe("delivery detail", () => {
  it("an agent message keeps the sender and the unwrapped text", () => {
    assert.deepStrictEqual(detailOf([row(sessionEnvelope(A, "hello\nrest"), alpha)]), [
      { sender: alpha, message: "hello\nrest" },
    ])
  })

  it("a notice is from vibest; a send with no session is from the user and stays as typed", () => {
    const pasted = sessionEnvelope(A, "an example")

    assert.deepStrictEqual(
      detailOf([row(noticeEnvelope("gone\nmore"), { type: "vibest" }), row(pasted, { type: "user" })]),
      [
        { sender: { type: "vibest" }, message: "gone\nmore" },
        { sender: { type: "user" }, message: pasted },
      ],
    )
  })

  it("a plugin message names the plugin and is unwrapped", () => {
    assert.deepStrictEqual(detailOf([row(noticeEnvelope("nothing sent"), { type: "plugin", plugin: "reminder" })]), [
      { sender: { type: "plugin", plugin: "reminder" }, message: "nothing sent" },
    ])
  })
})
