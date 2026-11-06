import { assert, describe, it } from "@effect/vitest"

import { claudeAccount, claudeUsage, cursorAccount, cursorUsage, piAccount } from "./index.ts"

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

  it("reads the 5-hour and weekly windows from the OAuth usage endpoint", () => {
    const body = {
      five_hour: {
        utilization: 4.0,
        resets_at: "2026-10-31T17:20:00.296129+00:00",
        limit_dollars: null,
        locked_reason: null,
      },
      seven_day: {
        utilization: 10.0,
        resets_at: "2026-11-01T21:00:00.296147+00:00",
        limit_dollars: null,
        locked_reason: null,
      },
      seven_day_opus: null,
      seven_day_sonnet: null,
      extra_usage: { is_enabled: false },
    }
    assert.deepStrictEqual(claudeUsage(body), [
      { window: "5h", percent: 4, status: "available", resetTime: Date.parse("2026-10-31T17:20:00.296Z") },
      { window: "7d", percent: 10, status: "available", resetTime: Date.parse("2026-11-01T21:00:00.296Z") },
    ])
    assert.strictEqual(claudeUsage({ five_hour: { utilization: 100, resets_at: null } })[0]?.status, "limited")
    assert.deepStrictEqual(claudeUsage({ error: { type: "rate_limit_error" } }), [])
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

  it("reads the monthly buckets from GetCurrentPeriodUsage", () => {
    const usage = {
      billingCycleStart: "1792208404000",
      billingCycleEnd: "1794886804000",
      planUsage: {
        totalSpend: 111262,
        includedSpend: 40000,
        limit: 40000,
        autoPercentUsed: 36.289,
        apiPercentUsed: 23.94,
        totalPercentUsed: 35.891,
      },
      spendLimitUsage: { limitType: "user" },
    }
    assert.deepStrictEqual(cursorUsage(usage, { noUsageBasedAllowed: true }), [
      { window: "monthly", percent: 35.891, status: "available", resetTime: 1794886804000 },
      { window: "monthly-auto", percent: 36.289, status: "available", resetTime: 1794886804000 },
      { window: "monthly-api", percent: 23.94, status: "available", resetTime: 1794886804000 },
    ])
    const full = { billingCycleEnd: "0", planUsage: { includedSpend: 40000, limit: 40000 } }
    assert.deepStrictEqual(cursorUsage(full, { noUsageBasedAllowed: true }), [
      { window: "monthly", percent: 100, status: "limited", resetTime: null },
    ])
    assert.strictEqual(cursorUsage(full, { hardLimit: 50 })[0]?.status, "available")
    assert.deepStrictEqual(cursorUsage({ spendLimitUsage: { limitType: "team" } }), [])
    const capped = {
      billingCycleEnd: "1794886804000",
      planUsage: { totalPercentUsed: 100, autoPercentUsed: 100, apiPercentUsed: 100, limit: 40000 },
    }
    assert.deepStrictEqual(
      cursorUsage(capped).map((limit) => limit.status),
      ["available", "available", "available"],
    )
    const split = {
      billingCycleEnd: "1794886804000",
      planUsage: { totalPercentUsed: 30, autoPercentUsed: 100, apiPercentUsed: 20, limit: 40000 },
    }
    assert.deepStrictEqual(
      cursorUsage(split, { noUsageBasedAllowed: true }).map((limit) => [limit.window, limit.status]),
      [
        ["monthly", "available"],
        ["monthly-auto", "available"],
        ["monthly-api", "available"],
      ],
    )
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
})
