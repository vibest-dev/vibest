import { assert, describe, it } from "@effect/vitest"
import { detailOf, noticeEnvelope, sessionEnvelope } from "@vibest/core/replies"
import type { Sender } from "@vibest/schema/event"

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const alpha = { session: A, agent: "general", title: "Alpha" }

const row = (message: string, sender: string | null, from: Sender | null, kind = "send") => ({
  kind,
  sender,
  from,
  message,
})

describe("delivery detail", () => {
  it("an agent message keeps the sender and the unwrapped text", () => {
    assert.deepStrictEqual(detailOf([row(sessionEnvelope(A, "hello\nrest"), A, alpha)]), [
      { sender: alpha, message: "hello\nrest" },
    ])
  })

  it("a notice is from vibest; a send with no session is from the user and stays as typed", () => {
    const pasted = sessionEnvelope(A, "an example")

    assert.deepStrictEqual(detailOf([row(noticeEnvelope("gone\nmore"), A, null, "notice"), row(pasted, null, null)]), [
      { sender: "vibest", message: "gone\nmore" },
      { sender: "user", message: pasted },
    ])
  })

  it("a remote sender keeps its machine, and one without an agent shows only the machine and id", () => {
    assert.deepStrictEqual(
      detailOf([
        row(sessionEnvelope("mb/aaaaaaaa", "report"), null, { ...alpha, machine: "mb" }),
        row(sessionEnvelope("mb/aaaaaaaa", "old peer"), null, { session: A, machine: "mb" }),
      ]),
      [
        { sender: { ...alpha, machine: "mb" }, message: "report" },
        { sender: { address: "mb/aaaaaaaa" }, message: "old peer" },
      ],
    )
  })
})
