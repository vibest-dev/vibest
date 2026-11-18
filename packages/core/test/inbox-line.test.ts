import { assert, describe, it } from "@effect/vitest"
import { detailOf, noticeEnvelope, sessionEnvelope } from "@vibest/core/replies"

const titles = { a: { agent: "general", title: "Alpha" }, b: { agent: "coordinator", title: "Beta" } }
const who = (id: string) => (id === "a" || id === "b" ? titles[id] : undefined)

const row = (message: string, sender: string | null, kind = "send") => ({ kind, sender, message })

describe("delivery detail", () => {
  it("an agent message keeps the sender and the unwrapped text", () => {
    assert.deepStrictEqual(detailOf([row(sessionEnvelope({ id: "a", title: "Alpha" }, "hello\nrest"), "a")], who), [
      { sender: { agent: "general", title: "Alpha", session: "a" }, message: "hello\nrest" },
    ])
  })

  it("a notice is from vibest and a send with no session is from the user", () => {
    assert.deepStrictEqual(
      detailOf(
        [row(noticeEnvelope("gone\nmore"), "a", "notice"), row("hello from the terminal", null)],
        () => undefined,
      ),
      [
        { sender: "vibest", message: "gone\nmore" },
        { sender: "user", message: "hello from the terminal" },
      ],
    )
  })

  it("keeps every message, including two from one sender", () => {
    assert.deepStrictEqual(detailOf([row("first", "a"), row("second", "a")], who), [
      { sender: { agent: "general", title: "Alpha", session: "a" }, message: "first" },
      { sender: { agent: "general", title: "Alpha", session: "a" }, message: "second" },
    ])
  })
})
