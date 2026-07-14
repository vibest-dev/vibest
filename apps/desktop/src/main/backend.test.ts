import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveServerEntry } from "./backend";

describe("resolveServerEntry", () => {
  it("points at the collected server dependency in a packaged app", () => {
    const entry = resolveServerEntry(true, "/Applications/Vibest.app/Contents/Resources");
    expect(entry).toBe(
      path.join(
        "/Applications/Vibest.app/Contents/Resources",
        "app.asar",
        "node_modules",
        "@vibest",
        "cli",
        "dist",
        "cli.mjs",
      ),
    );
  });

  it("points at the monorepo build when unpackaged", () => {
    const entry = resolveServerEntry(false, "/unused");
    expect(entry).toMatch(/packages[/\\]vibest[/\\]dist[/\\]cli\.mjs$/);
  });
});
