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
    expect(
      isAllowedOrigin("https://app.vibest.dev", { extraOrigins: ["https://app.vibest.dev"] }),
    ).toBe(true);
    expect(isAllowedOrigin("https://app.vibest.dev")).toBe(false);
  });

  it("trusts an origin whose hostname is an allowed Host — the page a trusted proxy serves must be able to connect back", () => {
    expect(isAllowedOrigin("https://proxy.ts.net", { allowedHosts: ["proxy.ts.net"] })).toBe(true);
    // Scheme and port do not matter for a trusted hostname…
    expect(isAllowedOrigin("http://proxy.ts.net:8443", { allowedHosts: ["proxy.ts.net"] })).toBe(
      true,
    );
    // …and an allowlist entry carrying a port still matches.
    expect(isAllowedOrigin("https://proxy.ts.net", { allowedHosts: ["proxy.ts.net:8443"] })).toBe(
      true,
    );
  });

  it("does not widen to other hostnames when allowed hosts are configured", () => {
    expect(isAllowedOrigin("https://evil.example", { allowedHosts: ["proxy.ts.net"] })).toBe(false);
    expect(isAllowedOrigin("not-a-url", { allowedHosts: ["proxy.ts.net"] })).toBe(false);
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

  it("accepts an allowlisted proxy Host whether or not the entry carries a port", () => {
    expect(isLoopbackHost("proxy.ts.net", ["proxy.ts.net"])).toBe(true);
    expect(isLoopbackHost("proxy.ts.net:443", ["proxy.ts.net"])).toBe(true);
    // A configured `host:port` entry must not silently never match.
    expect(isLoopbackHost("proxy.ts.net:8443", ["proxy.ts.net:8443"])).toBe(true);
    expect(isLoopbackHost("PROXY.TS.NET", ["proxy.ts.net"])).toBe(true);
    expect(isLoopbackHost("evil.example", ["proxy.ts.net"])).toBe(false);
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
