import { assert, describe, it } from "@effect/vitest"
import { detailOf, noticeEnvelope, sessionEnvelope } from "@vibest/core/replies"
import type { Sender } from "@vibest/schema/event"

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const alpha = { session: A, agent: "general", title: "Alpha" }

const row = (message: string, sender: Sender, kind = "send") => ({ kind, sender, message })

describe("delivery detail", () => {
  it("an agent message keeps the sender and the unwrapped text", () => {
    assert.deepStrictEqual(detailOf([row(sessionEnvelope(A, "hello\nrest"), alpha)]), [
      { sender: alpha, message: "hello\nrest" },
    ])
  })

  it("a notice is from vibest; a send with no session is from the user and stays as typed", () => {
    const pasted = sessionEnvelope(A, "an example")

    assert.deepStrictEqual(detailOf([row(noticeEnvelope("gone\nmore"), "vibest", "notice"), row(pasted, "user")]), [
      { sender: "vibest", message: "gone\nmore" },
      { sender: "user", message: pasted },
    ])
  })

  it("a plugin message names the plugin and is unwrapped", () => {
    assert.deepStrictEqual(detailOf([row(noticeEnvelope("nothing sent"), { plugin: "reminder" })]), [
      { sender: { plugin: "reminder" }, message: "nothing sent" },
    ])
  })

  it("a remote sender keeps its machine, and one without an agent shows only the machine and id", () => {
    assert.deepStrictEqual(
      detailOf([
        row(sessionEnvelope("mb/aaaaaaaa", "report"), { ...alpha, machine: "mb" }),
        row(sessionEnvelope("mb/aaaaaaaa", "old peer"), { session: A, machine: "mb" }),
      ]),
      [
        { sender: { ...alpha, machine: "mb" }, message: "report" },
        { sender: { address: "mb/aaaaaaaa" }, message: "old peer" },
      ],
    )
  })
})
