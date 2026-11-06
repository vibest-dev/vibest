import { assert, describe, it } from "@effect/vitest"

import { terminalName } from "../src/terminal-runtime.ts"

const session = "a09e0000-0000-4000-8000-000000000000"
const input = {
  project: "/work/My Project",
  cwd: "/work/My Project",
  argv: [],
  env: { VIBEST_SESSION_ID: session, VIBEST_HARNESS: "claude" },
  label: "a09e0000 Fix login bug",
}

describe("hc terminal names", () => {
  it("uses the title without the placement id prefix and keeps a session suffix", () => {
    assert.strictEqual(terminalName(input), "fix-login-bug-a09e")
    assert.strictEqual(terminalName({ ...input, label: "Fix login bug" }), "fix-login-bug-a09e")
    assert.strictEqual(terminalName({ ...input, label: "Réparer LOGIN!" }), "reparer-login-a09e")
  })

  it("falls back to the harness when the title has no slug", () => {
    assert.strictEqual(terminalName({ ...input, label: "修复登录 🔧" }), "claude-a09e")
    assert.strictEqual(terminalName({ ...input, label: "", env: { VIBEST_SESSION_ID: session } }), "agent-a09e")
  })

  it("names a new main terminal after its project", () => {
    assert.strictEqual(terminalName({ ...input, env: {} }), "my-project-main")
    assert.strictEqual(terminalName({ ...input, env: {}, project: "/work/My Project/" }), "my-project-main")
    assert.strictEqual(terminalName({ ...input, env: {}, project: "/修复/" }), "main")
  })

  it("keeps suffixes and collision counters inside the 32-character limit", () => {
    for (let attempt = 0; attempt <= 8; attempt++) {
      for (const env of [input.env, {}]) {
        const name = terminalName({ ...input, env, label: "x".repeat(80), project: "/" + "x".repeat(80) }, attempt)
        assert.match(name, /^[a-z0-9-]{1,32}$/)
        assert.isTrue(
          name.endsWith(`${"VIBEST_SESSION_ID" in env ? "a09e" : "main"}${attempt === 0 ? "" : `-${attempt + 1}`}`),
        )
      }
    }
  })
})
