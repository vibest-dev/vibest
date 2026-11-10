import { assert, describe, it } from "@effect/vitest"

import { claudeAccount, cursorAccount, piAccount } from "../src/subscriptions/index.ts"
import { providersFromList } from "../src/subscriptions/pi.ts"

describe("claude", () => {
  it("reads a claude.ai login from `claude auth status --json`", () => {
    const status = {
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      email: "<redacted>",
      orgId: "<redacted>",
      subscriptionType: "max",
    }
    assert.deepStrictEqual(claudeAccount(status), { kind: "subscription", plan: "max" })
    assert.deepStrictEqual(claudeAccount({ loggedIn: false }), { kind: "none" })
    assert.deepStrictEqual(claudeAccount({ loggedIn: true, authMethod: "api_key" }), { kind: "api-key" })
    assert.deepStrictEqual(claudeAccount("not json"), { kind: "none" })
  })
})

describe("cursor", () => {
  it("reads the login and plan from `status` and `about`", () => {
    const status = {
      status: "authenticated",
      isAuthenticated: true,
      hasAccessToken: true,
      userInfo: { email: "<redacted>" },
    }
    assert.deepStrictEqual(cursorAccount(status, { subscriptionTier: "Ultra" }), {
      kind: "subscription",
      plan: "Ultra",
    })
    assert.deepStrictEqual(cursorAccount(status), { kind: "subscription" })
    assert.deepStrictEqual(cursorAccount({ status: "unauthenticated", isAuthenticated: false }), { kind: "none" })
  })
})

describe("pi", () => {
  it("reads `pi auth check --json` per provider", () => {
    assert.deepStrictEqual(piAccount({ status: "ready", provider: "example-proxy", authType: "api_key" }), {
      kind: "api-key",
      provider: "example-proxy",
    })
    assert.deepStrictEqual(
      piAccount({ status: "not_ready", provider: "anthropic", reason: "credentials_not_configured" }),
      { kind: "none", provider: "anthropic" },
    )
    assert.deepStrictEqual(piAccount({ status: "not_ready", provider: "cpa", reason: "provider_not_found" }), {
      kind: "none",
      provider: "cpa",
    })
    assert.deepStrictEqual(piAccount({ status: "ready", provider: "anthropic", authType: "oauth" }), {
      kind: "subscription",
      provider: "anthropic",
    })
  })

  it("reads providers from `pi --list-models`, and nothing else", () => {
    const table = [
      "provider  model  context",
      "fake      m      1K",
      "second    m2     1K",
      "fake      other  1K",
    ].join("\n")
    assert.deepStrictEqual(providersFromList(table), ["fake", "second"])
    assert.deepStrictEqual(providersFromList("No models available. Use /login\n  docs"), [])
    assert.strictEqual(providersFromList(""), undefined)
    assert.strictEqual(providersFromList("not a model list"), undefined)
  })
})
