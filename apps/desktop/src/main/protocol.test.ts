import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAssetPath } from "./protocol";

const ROOT = path.resolve("/app/renderer");

describe("resolveAssetPath", () => {
  it("resolves a file inside the renderer root", () => {
    expect(resolveAssetPath(ROOT, "/assets/index.js")).toBe(path.join(ROOT, "assets", "index.js"));
  });

  it("resolves the root path", () => {
    expect(resolveAssetPath(ROOT, "/")).toBe(ROOT);
  });

  it("decodes percent-encoded paths", () => {
    expect(resolveAssetPath(ROOT, "/assets/a%20b.js")).toBe(path.join(ROOT, "assets", "a b.js"));
  });

  it("refuses to escape the renderer root", () => {
    expect(resolveAssetPath(ROOT, "/../../etc/passwd")).toBeNull();
  });

  it("refuses an encoded traversal", () => {
    expect(resolveAssetPath(ROOT, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  });
});
