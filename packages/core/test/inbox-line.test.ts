import { assert, describe, it } from "@effect/vitest"
import { displayOf, noticeEnvelope, sessionEnvelope } from "@vibest/core/replies"

const titles = { a: { agent: "general", title: "Alpha" }, b: { agent: "coordinator", title: "Beta" } }
const who = (id: string) => (id === "a" || id === "b" ? titles[id] : undefined)

const row = (message: string, sender: string | null, kind = "send") => ({ kind, sender, message })

describe("delivery display", () => {
  it("an agent message names that sender and previews its first line", () => {
    assert.deepStrictEqual(displayOf([row(sessionEnvelope({ id: "a", title: "Alpha" }, "hello\nrest"), "a")], who), [
      { sender: { agent: "general", title: "Alpha", session: "a" }, preview: "hello" },
    ])
  })

  it("a notice is from vibest", () => {
    assert.deepStrictEqual(
      displayOf([row(noticeEnvelope("gone\nmore"), "a", "notice")], () => undefined),
      [{ sender: "vibest", preview: "gone" }],
    )
  })

  it("lists each sender once and previews that sender's first message", () => {
    assert.deepStrictEqual(
      displayOf(
        [row("first", "a"), row("second", "a"), row("third", "b"), row(noticeEnvelope("n"), null, "notice")],
        who,
      ),
      [
        { sender: { agent: "general", title: "Alpha", session: "a" }, preview: "first" },
        { sender: { agent: "coordinator", title: "Beta", session: "b" }, preview: "third" },
        { sender: "vibest", preview: "n" },
      ],
    )
  })

  it("trims a preview to about 120 characters", () => {
    const preview = displayOf([row("x".repeat(200), "a")], who)[0]!.preview
    assert.strictEqual([...preview].length, 120)
    assert.ok(preview.endsWith("…"))
  })
})
