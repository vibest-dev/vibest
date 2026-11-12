import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, assert, describe, it } from "vitest"

import { files } from "../src/plugin.ts"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-cursor-"))
for (const [name, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
  fs.writeFileSync(path.join(dir, name), text)
}
const bin = path.join(dir, "bin")
const calls = path.join(dir, "calls.log")
fs.mkdirSync(bin)
fs.writeFileSync(
  path.join(bin, "vibest"),
  `#!/bin/sh\necho "$* <$(cat)>" >> ${calls}\necho "\${FAKE_OUT:-}"\nexit "\${FAKE_EXIT:-0}"\n`,
  { mode: 0o755 },
)
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const run = (event: string, env: Record<string, string>, stdin = "{}") => {
  fs.rmSync(calls, { force: true })
  const hooks = JSON.parse(files["hooks/hooks.json"]!).hooks as Record<string, Array<{ command: string }>>
  const p = Bun.spawnSync(["sh", "-c", hooks[event]![0]!.command], {
    cwd: dir,
    env: { PATH: `${bin}:/usr/bin:/bin`, VIBEST_HOME: dir, ...env },
    stdin: new TextEncoder().encode(stdin),
  })
  return {
    code: p.exitCode,
    stdout: p.stdout.toString().trim(),
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim() : "",
  }
}

const agent = { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" }

describe("@vibest/cursor", () => {
  it("outside a vibest agent: allows without asking vibest, and reports nothing", () => {
    assert.deepStrictEqual(run("preToolUse", {}), { code: 0, stdout: '{"permission":"allow"}', calls: "" })
    assert.deepStrictEqual(run("beforeSubmitPrompt", {}, '{"prompt":"look"}'), { code: 0, stdout: "", calls: "" })
    assert.deepStrictEqual(run("afterAgentResponse", {}), { code: 0, stdout: "", calls: "" })
    assert.deepStrictEqual(run("sessionStart", {}), { code: 0, stdout: "", calls: "" })
  })

  it("a vibest agent's tool call: vibest's answer, and a refusal when vibest fails", () => {
    const deny = '{"permission":"deny"}'
    assert.deepStrictEqual(run("preToolUse", { ...agent, FAKE_OUT: deny }, '{"tool_name":"Shell"}'), {
      code: 0,
      stdout: deny,
      calls: 'integration guard --harness cursor <{"tool_name":"Shell"}>',
    })
    assert.strictEqual(run("preToolUse", { ...agent, FAKE_EXIT: "1" }).code, 2)
  })

  it("runs the vibest in VIBEST_COMMAND, not the one on PATH; an argv it cannot read safely falls back to PATH", () => {
    const own = path.join(dir, "own vibest")
    fs.writeFileSync(own, `#!/bin/sh\necho "own $* <$(cat)>" >> ${calls}\n`, { mode: 0o755 })
    const viaSh = run("afterAgentResponse", { ...agent, VIBEST_COMMAND: JSON.stringify(["sh", own]) }, "{}")
    assert.strictEqual(viaSh.calls, "own integration stop --harness cursor <{}>")
    const escaped = run("afterAgentResponse", { ...agent, VIBEST_COMMAND: '["/x\\"y"]' }, "{}")
    assert.strictEqual(escaped.calls, "integration stop --harness cursor <{}>")
  })

  it("a vibest agent's session start, execution activity and response go to `vibest integration ready`, `prompt` and `stop`; Cursor's own stop is not hooked", () => {
    const hooks = JSON.parse(files["hooks/hooks.json"]!).hooks as Record<string, unknown>
    assert.deepStrictEqual(Object.keys(hooks).sort(), [
      "afterAgentResponse",
      "afterAgentThought",
      "beforeSubmitPrompt",
      "postToolUse",
      "preToolUse",
      "sessionStart",
    ])
    const home = path.join(dir, "home")
    fs.mkdirSync(home, { recursive: true })
    for (const [event, stdin, command] of [
      ["sessionStart", '{"session_id":"c"}', "ready"],
      ["beforeSubmitPrompt", '{"prompt":"look"}', "prompt"],
      ["afterAgentThought", '{"text":"hm"}', "prompt"],
      ["postToolUse", '{"tool_name":"Shell"}', "prompt"],
      ["afterAgentResponse", '{"text":"done"}', "stop"],
    ] as const)
      assert.deepStrictEqual(run(event, { ...agent, VIBEST_HOME: home, FAKE_OUT: "noise" }, stdin), {
        code: 0,
        stdout: "",
        calls: `integration ${command} --harness cursor <${stdin}>`,
      })
  })

  it("a report vibest could not deliver fails the hook and its error lands in vibestd.log", () => {
    const home = path.join(dir, "failing")
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(
      path.join(bin, "failing"),
      "#!/bin/sh\ncat >/dev/null\necho 'vibest: not delivered' >&2\nexit 1\n",
      {
        mode: 0o755,
      },
    )
    const r = run("afterAgentResponse", { ...agent, VIBEST_HOME: home, VIBEST_COMMAND: '["failing"]' }, "{}")
    assert.deepStrictEqual(r, { code: 1, stdout: "", calls: "" })
    assert.strictEqual(fs.readFileSync(path.join(home, "vibestd.log"), "utf8"), "vibest: not delivered\n")
  })
})
