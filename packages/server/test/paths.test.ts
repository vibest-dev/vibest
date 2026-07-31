import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveVibestHome } from "../src/config/paths";

describe("resolveVibestHome", () => {
  it("prefers an explicit VIBEST_HOME over any default", () => {
    expect(resolveVibestHome({ VIBEST_HOME: "/tmp/custom", NODE_ENV: "development" })).toBe(
      "/tmp/custom",
    );
  });

  it("defaults to ~/.vibest outside development", () => {
    expect(resolveVibestHome({})).toBe(path.join(os.homedir(), ".vibest"));
    expect(resolveVibestHome({ NODE_ENV: "production" })).toBe(path.join(os.homedir(), ".vibest"));
  });

  it("defaults to ~/.vibest-dev under NODE_ENV=development", () => {
    expect(resolveVibestHome({ NODE_ENV: "development" })).toBe(
      path.join(os.homedir(), ".vibest-dev"),
    );
  });
});
