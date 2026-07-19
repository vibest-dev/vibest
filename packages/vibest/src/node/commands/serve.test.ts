import { Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveServeConfig } from "./serve";

const ENV_KEYS = ["VIBEST_PORT", "VIBEST_CORS_ORIGINS", "NODE_ENV"] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveServeConfig", () => {
  it("prefers the flag over env and default for the port", () => {
    process.env.VIBEST_PORT = "5000";
    expect(resolveServeConfig({ port: Option.some(3000), corsOrigin: [] }).port).toBe(3000);
  });

  it("falls back to VIBEST_PORT when no flag is given", () => {
    process.env.VIBEST_PORT = "5000";
    expect(resolveServeConfig({ port: Option.none(), corsOrigin: [] }).port).toBe(5000);
  });

  it("defaults to 4000 in production and 0 in development", () => {
    expect(resolveServeConfig({ port: Option.none(), corsOrigin: [] }).port).toBe(4000);
    process.env.NODE_ENV = "development";
    expect(resolveServeConfig({ port: Option.none(), corsOrigin: [] }).port).toBe(0);
  });

  it("prefers repeated --cors-origin flags over VIBEST_CORS_ORIGINS", () => {
    process.env.VIBEST_CORS_ORIGINS = "https://env.example";
    expect(
      resolveServeConfig({ port: Option.none(), corsOrigin: ["https://a.test", "https://b.test"] })
        .corsOrigins,
    ).toEqual(["https://a.test", "https://b.test"]);
  });

  it("falls back to the comma-separated env list when no flag is given", () => {
    process.env.VIBEST_CORS_ORIGINS = " https://a.test , https://b.test ,";
    expect(resolveServeConfig({ port: Option.none(), corsOrigin: [] }).corsOrigins).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
  });
});
