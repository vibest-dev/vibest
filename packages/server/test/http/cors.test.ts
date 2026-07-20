import { describe, expect, it } from "vitest";

import { corsHeaders, isAllowedOrigin, isLoopbackHost } from "../../src/http/cors";

describe("isAllowedOrigin", () => {
  it("always trusts the desktop scheme, so a CLI-started daemon accepts the desktop", () => {
    expect(isAllowedOrigin("vibest://app")).toBe(true);
  });

  it("trusts loopback web clients on any port", () => {
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:4000")).toBe(true);
    expect(isAllowedOrigin("https://localhost:8443")).toBe(true);
  });

  it("rejects a non-loopback web origin", () => {
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("http://localhost.evil.example")).toBe(false);
  });

  it("accepts extra configured origins (e.g. a hosted web app)", () => {
    expect(isAllowedOrigin("https://app.vibest.dev", ["https://app.vibest.dev"])).toBe(true);
    expect(isAllowedOrigin("https://app.vibest.dev")).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  it("accepts the loopback hosts the server binds", () => {
    expect(isLoopbackHost("localhost:4000")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:4000")).toBe(true);
    expect(isLoopbackHost("[::1]:4000")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  it("rejects a rebinding host (attacker domain that resolved to loopback)", () => {
    expect(isLoopbackHost("evil.example")).toBe(false);
    expect(isLoopbackHost("evil.example:4000")).toBe(false);
  });

  it("allows a request with no Host — not a browser, gated elsewhere", () => {
    expect(isLoopbackHost(undefined)).toBe(true);
  });
});

describe("corsHeaders", () => {
  it("echoes an allowlisted origin rather than a wildcard", () => {
    expect(corsHeaders("vibest://app")?.["access-control-allow-origin"]).toBe("vibest://app");
    expect(corsHeaders("http://localhost:5173")?.["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
  });

  it("permits the Authorization header, which the renderer sends on every RPC call", () => {
    expect(corsHeaders("vibest://app")?.["access-control-allow-headers"]).toContain(
      "authorization",
    );
  });

  it("varies on origin, so a shared cache cannot serve one origin's response to another", () => {
    expect(corsHeaders("vibest://app")?.vary).toBe("origin");
  });

  it("denies an origin outside the policy", () => {
    expect(corsHeaders("https://evil.example")).toBeNull();
  });

  it("returns null for a same-origin request, which sends no Origin header", () => {
    expect(corsHeaders(undefined)).toBeNull();
  });
});
