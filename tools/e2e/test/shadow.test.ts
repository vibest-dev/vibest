import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { claudeShadow, cursorShadow, userFilesRead, userPaths, userPrivateValues } from "../src/world/shadow.ts"

const fakeHome = async (files: Record<string, unknown>) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vbe-shadow-test-"))
  for (const [rel, value] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(home, rel)), { recursive: true })
    await fs.writeFile(path.join(home, rel), JSON.stringify(value))
  }
  return userPaths(home)
}

const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>

describe("shadows", () => {
  test("Claude settings env keeps no model, provider, base URL or key, so the fake base URL wins", async () => {
    const from = await fakeHome({
      ".claude/settings.json": {
        model: "user-model",
        env: {
          ANTHROPIC_BASE_URL: "https://real.example",
          ANTHROPIC_API_KEY: "k",
          ANTHROPIC_AUTH_TOKEN: "t",
          ANTHROPIC_MODEL: "m",
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_REGION: "r",
          SOME_SERVICE_TOKEN: "t",
          OTHER_BASE_URL: "https://other.example",
          HTTPS_PROXY: "http://proxy.example",
          FOO: "bar",
        },
      },
    })
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vbe-shadow-out-"))
    await claudeShadow(dir, "user", from)
    const settings = await read(path.join(dir, "settings.json"))
    expect(settings.model).toBeUndefined()
    expect(Object.keys(settings.env as object).sort()).toEqual(["FOO", "HTTPS_PROXY", "NO_PROXY", "no_proxy"])
    const env = { ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ...(settings.env as Record<string, string>) }
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1")
  })

  test("Cursor config copies only the keys the checks need, and the invariant hashes exactly those", async () => {
    const own = {
      version: 1,
      approvalMode: "allowlist",
      sandbox: { mode: "disabled" },
      permissions: { allow: ["Shell(ls)"], deny: [] },
      network: { useHttp1ForAgent: false },
      model: { modelId: "user-model-id", displayName: "User Model" },
      selectedModel: { modelId: "user-model-id" },
      modelSelectionHistory: ["user-model-id"],
      authInfo: { email: "someone@example.com", userId: 1, authId: "auth0|abc" },
    }
    const from = await fakeHome({ ".cursor/cli-config.json": own })
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vbe-shadow-out-"))
    await cursorShadow(dir, "user", "/bin/vibest", from)
    const copied = await read(path.join(dir, "cli-config.json"))
    const keys = Object.keys(copied).sort()
    expect(keys).toEqual(["approvalMode", "network", "permissions", "sandbox", "version"])
    expect(JSON.stringify(copied)).not.toContain("user-model-id")
    expect(JSON.stringify(copied)).not.toContain("someone@example.com")
    const hashed = userFilesRead.find((f) => f.file.endsWith(path.join(".cursor", "cli-config.json")))!.keys!
    expect([...hashed].sort()).toEqual(keys)
  })

  test("the user's model, provider and account values are known for redaction", async () => {
    const from = await fakeHome({
      ".claude/settings.json": { model: "claude-pick" },
      ".pi/agent/settings.json": { defaultProvider: "pi-provider", defaultModel: "pi-model" },
      ".cursor/cli-config.json": {
        model: { modelId: "cursor-id", displayName: "Cursor Model" },
        authInfo: { email: "someone@example.com" },
      },
    })
    expect((await userPrivateValues(from)).sort()).toEqual(
      ["Cursor Model", "claude-pick", "cursor-id", "pi-model", "pi-provider", "someone@example.com"].sort(),
    )
  })
})
