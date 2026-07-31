import net from "node:net";
import type { AddressInfo } from "node:net";

import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveServeConfig, runServe } from "../../src/http/serve";
import { ServerStartupError } from "../../src/http/server";

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

describe("runServe", () => {
  it("fails with a typed startup error when binding the port fails", async () => {
    // Occupy a port so runServe's listen stage fails after the server (and its
    // runtime) has been built; the scope then releases what was acquired.
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as AddressInfo;

    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(runServe({ port: Option.some(port), corsOrigin: [] })),
      );
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(error).toBeInstanceOf(ServerStartupError);
      expect((error as ServerStartupError).phase).toBe("listen");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
