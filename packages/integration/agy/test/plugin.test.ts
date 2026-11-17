import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, assert, describe, it } from "vitest"

import { files, PLUGIN } from "../src/plugin.ts"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-agy-"))

for (const [name, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
  fs.writeFileSync(path.join(dir, name), text)
}

const root = path.join(dir, PLUGIN)
const bin = path.join(dir, "bin")
const calls = path.join(dir, "calls.log")

fs.mkdirSync(bin)

fs.writeFileSync(
  path.join(bin, "vibest"),
  `#!/bin/sh\necho "$* <$(cat)>" >> ${calls}\necho "\${FAKE_OUT:-}"\nexit "\${FAKE_EXIT:-0}"\n`,
  { mode: 0o755 },
)

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const agent = { VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd", VIBEST_PROCESS: "3" }

const run = (event: string, payload: { readonly conversationId?: string }, env: Record<string, string> = agent) => {
  fs.rmSync(calls, { force: true })

  const hooks = JSON.parse(files[`${PLUGIN}/hooks.json`]!).vibest as Record<
    string,
    Array<{ command?: string; hooks?: Array<{ command: string }> }>
  >

  const entry = hooks[event]![0]!

  const p = Bun.spawnSync(["sh", "-c", entry.command ?? entry.hooks![0]!.command], {
    cwd: root,
    env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: dir, VIBEST_HOME: dir, ...env },
    stdin: new TextEncoder().encode(JSON.stringify({ hookEventName: event, ...payload }, null, 2)),
  })

  return {
    code: p.exitCode,
    stdout: p.stdout.toString().trim(),
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("integration ").length - 1 : 0,
  }
}

describe("@vibest/agy", () => {
  it("only the process's first conversation reports: a subagent's start and Stop do not", () => {
    assert.deepStrictEqual(run("SessionStart", { conversationId: "root" }), { code: 0, stdout: "{}", calls: 1 })
    assert.strictEqual(run("SessionStart", { conversationId: "sub" }).calls, 0)
    assert.deepStrictEqual(run("Stop", { conversationId: "sub" }), {
      code: 0,
      stdout: '{"decision":"allow"}',
      calls: 0,
    })
    assert.strictEqual(run("PreInvocation", { conversationId: "root" }).calls, 1)
    assert.strictEqual(run("Stop", { conversationId: "root" }).calls, 1)
  })

  it("a tool call gets vibest's answer, and a refusal when vibest fails", () => {
    const deny = '{"decision":"deny","reason":"no"}'
    assert.deepStrictEqual(run("PreToolUse", { conversationId: "sub" }, { ...agent, FAKE_OUT: deny }), {
      code: 0,
      stdout: deny,
      calls: 1,
    })
    assert.include(run("PreToolUse", {}, { ...agent, FAKE_EXIT: "1" }).stdout, '"decision":"deny"')
    assert.deepStrictEqual(run("PreToolUse", {}, {}), { code: 0, stdout: '{"decision":"allow"}', calls: 0 })
  })

  it("outside a vibest session nothing reaches vibest", () => {
    assert.deepStrictEqual(run("Stop", { conversationId: "root" }, {}), {
      code: 0,
      stdout: '{"decision":"allow"}',
      calls: 0,
    })
  })
})
