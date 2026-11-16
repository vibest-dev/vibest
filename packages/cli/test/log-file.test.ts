import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { trimLog } from "@vibest/platform-bun/log-file"

const fileIn = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-log-"))
  return path.join(dir, "vibestd.log")
}

describe("trimLog", () => {
  it("leaves a missing file missing and a short file unchanged", () => {
    const file = fileIn()
    trimLog(file)
    assert.isFalse(fs.existsSync(file))
    fs.writeFileSync(file, "hello\n")
    trimLog(file, { max: 100, keep: 40 })
    assert.strictEqual(fs.readFileSync(file, "utf8"), "hello\n")
  })

  it("keeps the tail from the next line and drops the head", () => {
    const file = fileIn()
    fs.writeFileSync(file, `HEAD\n${"X".repeat(50)}\nTAIL\n`)
    trimLog(file, { max: 40, keep: 20 })
    const text = fs.readFileSync(file, "utf8")
    assert.strictEqual(text, "TAIL\n")
    assert.ok(Buffer.byteLength(text) <= 20)
  })

  it("keeps a tailless chunk bounded by keep when the tail has no newline", () => {
    const file = fileIn()
    fs.writeFileSync(file, `HEAD${"Y".repeat(80)}`)
    trimLog(file, { max: 40, keep: 20 })
    assert.strictEqual(fs.readFileSync(file, "utf8"), "Y".repeat(20))
  })
})
