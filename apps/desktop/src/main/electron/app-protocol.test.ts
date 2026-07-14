import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type AppRequestHandler, createAppRequestHandler, resolveAssetPath } from "./app-protocol";

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
  it("dispatches Desktop RPC before the asset fallback", async () => {
    const rpc = vi.fn<AppRequestHandler>(async () => new Response("rpc", { status: 200 }));
    const handler = createAppRequestHandler(ROOT, rpc);

    const response = await handler(
      new Request("vibest://app/api/desktop-rpc/bootstrap", {
        method: "POST",
        body: "request-body",
      }),
    );

    expect(await response.text()).toBe("rpc");
    expect(rpc).toHaveBeenCalledOnce();
    await expect(rpc.mock.calls[0]![0].text()).resolves.toBe("request-body");
  });

  it("returns 404 when an RPC path does not match a procedure", async () => {
    const handler = createAppRequestHandler(ROOT, async () => undefined);

    const response = await handler(
      new Request("vibest://app/api/desktop-rpc/not-a-procedure", { method: "POST" }),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("rejects a different custom-protocol host", async () => {
    const rpc = vi.fn<AppRequestHandler>(async () => undefined);
    const handler = createAppRequestHandler(ROOT, rpc);

    const response = await handler(new Request("vibest://other/api/desktop-rpc/bootstrap"));

    expect(response.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });
});
