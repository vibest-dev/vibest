import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createAppRequestHandler, type FetchAsset, resolveAssetPath } from "./app-protocol";

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

  it("returns null for malformed percent encoding", () => {
    expect(resolveAssetPath(ROOT, "/broken%2")).toBeNull();
  });
});

describe("createAppRequestHandler", () => {
  it("serves a renderer asset without an RPC dispatch path", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibest-renderer-"));
    const asset = path.join(root, "asset.js");
    writeFileSync(asset, "asset");
    const fetch = vi.fn<FetchAsset>(async () => new Response("asset"));

    const response = await createAppRequestHandler(
      root,
      fetch,
    )(new Request("vibest://app/asset.js"));

    expect(await response.text()).toBe("asset");
    expect(fetch).toHaveBeenCalledWith(pathToFileURL(asset).toString());
  });

  it("falls back to the SPA entry for an unknown renderer path", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibest-renderer-"));
    const entry = path.join(root, "index.html");
    writeFileSync(entry, "app");
    const fetch = vi.fn<FetchAsset>(async () => new Response("app"));

    const response = await createAppRequestHandler(
      root,
      fetch,
    )(new Request("vibest://app/chat/session"));

    expect(await response.text()).toBe("app");
    expect(fetch).toHaveBeenCalledWith(pathToFileURL(entry).toString());
  });

  it("rejects a different custom-protocol host", async () => {
    const fetch = vi.fn<FetchAsset>(async () => new Response("asset"));
    const response = await createAppRequestHandler(
      ROOT,
      fetch,
    )(new Request("vibest://other/asset.js"));

    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
