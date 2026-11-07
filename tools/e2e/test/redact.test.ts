import { expect, test } from "bun:test"

import { privateIn, redactWith } from "../src/world.ts"

test("evidence loses the user's model value but keeps longer names that contain it", () => {
  const text = JSON.stringify({
    defaultModel: "opus",
    models: ["claude-opus-9", "opus"],
    doctor: "runs opus by default",
  })
  const out = redactWith(text, ["s3cret"], ["opus"])
  expect(privateIn(out, ["opus"])).toEqual([])
  expect(out).toContain("claude-opus-9")
  expect(out).toContain('"defaultModel":"<redacted>"')
  expect(privateIn(text, ["opus"])).toEqual(["opus"])
  expect(redactWith("key s3cret!", ["s3cret"], [])).toBe("key <redacted>!")
})
