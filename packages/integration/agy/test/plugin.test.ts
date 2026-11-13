import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, assert, describe, it } from "vitest"

import { files } from "../src/plugin.ts"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-agy-"))
const script = path.join(dir, "status.sh")
fs.writeFileSync(script, files["status.sh"]!)
const bin = path.join(dir, "bin")
const calls = path.join(dir, "calls.log")
fs.mkdirSync(bin)
fs.writeFileSync(path.join(bin, "vibest"), `#!/bin/sh\necho "$* <$(cat)>" >> ${calls}\n`, { mode: 0o755 })
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const callback = (state: string, conversation: string) => {
  const p = Bun.spawnSync(["sh", script], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: dir,
      VIBEST_HOME: dir,
      VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
      VIBEST_PROCESS: "3",
    },
    stdin: new TextEncoder().encode(JSON.stringify({ agent_state: state, conversation_id: conversation })),
  })
  return { code: p.exitCode, stdout: p.stdout.toString() }
}

describe("@vibest/agy", () => {
  it("the status line prints nothing and reports a conversation id to vibestd once", () => {
    const first = callback("working", "11111111-1111-4111-8111-111111111111")
    callback("idle", "11111111-1111-4111-8111-111111111111")
    assert.deepStrictEqual(first, { code: 0, stdout: "" })
    assert.deepStrictEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), [
      `integration prompt --harness agy <{"agent_state":"working","conversation_id":"11111111-1111-4111-8111-111111111111"}>`,
    ])
  })

  it("before a conversation exists nothing is reported", () => {
    fs.rmSync(calls)
    callback("authenticating", "")
    assert.isFalse(fs.existsSync(calls))
  })
})
