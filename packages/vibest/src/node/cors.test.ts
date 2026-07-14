import { describe, expect, it } from "vitest";

import { corsHeaders } from "./cors";

const ALLOWED = ["vibest://app", "http://localhost:5173"];

describe("corsHeaders", () => {
  it("allows an allowlisted origin", () => {
    const headers = corsHeaders("vibest://app", ALLOWED);
    expect(headers).not.toBeNull();
    expect(headers?.["access-control-allow-origin"]).toBe("vibest://app");
  });

  it("echoes the request origin rather than a wildcard", () => {
    const headers = corsHeaders("http://localhost:5173", ALLOWED);
    expect(headers?.["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("permits the Authorization header, which the renderer sends on every RPC call", () => {
    const headers = corsHeaders("vibest://app", ALLOWED);
    expect(headers?.["access-control-allow-headers"]).toContain("authorization");
  });

  it("varies on origin, so a shared cache cannot serve one origin's response to another", () => {
    const headers = corsHeaders("vibest://app", ALLOWED);
    expect(headers?.vary).toBe("origin");
  });

  it("rejects an origin that is not allowlisted", () => {
    expect(corsHeaders("https://evil.example", ALLOWED)).toBeNull();
  });

  it("returns null for a same-origin request, which sends no Origin header", () => {
    expect(corsHeaders(undefined, ALLOWED)).toBeNull();
  });

  it("returns null when nothing is allowlisted", () => {
    expect(corsHeaders("vibest://app", [])).toBeNull();
  });
});
