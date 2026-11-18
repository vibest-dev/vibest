import { assert, describe, it } from "@effect/vitest"
import { line } from "@vibest/core/inbox"
import { noticeEnvelope, sessionEnvelope } from "@vibest/core/replies"
import type { InboxRow } from "@vibest/schema/session"

const row = (message: string, sender: string | null, kind: InboxRow["kind"] = "send"): InboxRow => ({
  id: 1,
  sender,
  recipient: "r",
  kind,
  message,
  status: "delivered",
})

const titles = { a: "Alpha", b: "Beta" }
const titleOf = (id: string) => (id === "a" || id === "b" ? titles[id] : undefined)

describe("delivery line", () => {
  it("names the sender and the first line of the message", () => {
    assert.strictEqual(
      line([row(sessionEnvelope({ id: "a", title: "Alpha" }, "hello\nrest"), "a")], titleOf),
      "Message from @Alpha: hello",
    )
  })

  it("a notice is from vibest", () => {
    assert.strictEqual(
      line([row(noticeEnvelope("gone\nmore"), "a", "notice")], () => "nope"),
      "Message from @vibest: gone",
    )
  })

  it("lists each sender once and keeps the first message's first line", () => {
    assert.strictEqual(
      line(
        [row("first", "a"), row("second", "a"), row("third", "b"), row(noticeEnvelope("n"), null, "notice")],
        titleOf,
      ),
      "Message from @Alpha, @Beta, @vibest: first",
    )
  })

  it("trims the first line to about 80 characters", () => {
    const shown = line([row("x".repeat(200), "a")], titleOf)
    const preview = shown.slice("Message from @Alpha: ".length)
    assert.strictEqual([...preview].length, 80)
    assert.ok(preview.endsWith("…"))
  })
})
