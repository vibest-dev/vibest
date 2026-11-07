import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { copyEvidence, privateIn, redactWith } from "../src/world.ts"

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

test("copied pty evidence is redacted and otherwise kept byte for byte", async () => {
  const from = await fs.mkdtemp(path.join(os.tmpdir(), "vbe-pty-from-"))
  const to = await fs.mkdtemp(path.join(os.tmpdir(), "vbe-pty-to-"))
  const bytes = [0x1b, 0x5d, 0xff, 0x00, ...Buffer.from(" ok\n")]
  await fs.mkdir(path.join(from, "a"))
  await fs.writeFile(path.join(from, "a/out.pty"), Buffer.from(bytes))
  await fs.writeFile(path.join(from, "screen.txt"), "model opus ready")
  await copyEvidence(from, to, ["opus"])
  expect([...(await fs.readFile(path.join(to, "a/out.pty")))]).toEqual(bytes)
  expect(await fs.readFile(path.join(to, "screen.txt"), "utf8")).toBe("model <redacted> ready")
})
