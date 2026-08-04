import http from "node:http";
import type { AddressInfo } from "node:net";

import { Context, Effect, Scope } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createServer, type ManagedServer } from "../../src/http/server";
import type { UIApp } from "../../src/http/ui";
import type { RpcRuntime } from "../../src/rpc";

const TOKEN = "test-token-0000";

let server: ManagedServer | undefined;

async function start(options: Parameters<typeof createServer>[0]): Promise<string> {
  server = await createServer(options);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await server?.dispose();
  server = undefined;
});

describe("createServer auth", () => {
  it("serves /api/health without a token", async () => {
    const base = await start({ authToken: TOKEN });
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
  });

  it("does not expose an HTTP RPC endpoint", async () => {
    const base = await start({ authToken: TOKEN });
    const response = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  it("rejects a wrong token", async () => {
    const base = await start({ authToken: TOKEN });
    const response = await fetch(`${base}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token-000" },
    });
    expect(response.status).toBe(401);
  });

  it("issues a ticket to an authenticated caller", async () => {
    const base = await start({ authToken: TOKEN });
    const response = await fetch(`${base}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ticket: string };
    expect(body.ticket).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("requires no token at all when none is configured (browser mode)", async () => {
    const base = await start({});
    const response = await fetch(`${base}/api/ws-ticket`, { method: "POST" });
    expect(response.status).toBe(200);
  });
});

describe("createServer CORS", () => {
  it("answers a preflight from an allowlisted origin", async () => {
    const base = await start({ authToken: TOKEN, corsOrigins: ["vibest://app"] });
    const response = await fetch(`${base}/api/ws-ticket`, {
      method: "OPTIONS",
      headers: { origin: "vibest://app" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("vibest://app");
  });

  it("refuses a preflight from an unknown origin", async () => {
    const base = await start({ authToken: TOKEN, corsOrigins: ["vibest://app"] });
    const response = await fetch(`${base}/api/ws-ticket`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });
});

describe("createServer anti DNS-rebinding", () => {
  it("refuses a request whose Host is not loopback, even /api/health", async () => {
    await start({});
    const { port } = server!.address() as AddressInfo;
    const status = await new Promise<number>((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/health", headers: { host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", () => resolve(0));
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe("createServer WebSocket ticket", () => {
  async function connect(
    base: string,
    query: string,
    path = "/ws/rpc",
    options?: WebSocket.ClientOptions,
  ): Promise<number> {
    const url = `${base.replace("http://", "ws://")}${path}${query}`;
    const socket = new WebSocket(url, "vibest", options);
    return await new Promise<number>((resolve) => {
      socket.on("open", () => {
        socket.close();
        resolve(200);
      });
      socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.on("error", () => resolve(0));
    });
  }

  it("accepts an upgrade carrying a valid ticket", async () => {
    const base = await start({ authToken: TOKEN });
    const ticketResponse = await fetch(`${base}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    expect(await connect(base, `?ticket=${ticket}`)).toBe(200);
  });

  it("rejects an upgrade with no ticket", async () => {
    const base = await start({ authToken: TOKEN });
    expect(await connect(base, "")).toBe(401);
  });

  it("only upgrades the WebSocket RPC path without consuming the ticket", async () => {
    const base = await start({ authToken: TOKEN });
    const ticketResponse = await fetch(`${base}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    expect(await connect(base, `?ticket=${ticket}`, "/wrong-path")).toBe(404);
    expect(await connect(base, `?ticket=${ticket}`)).toBe(200);
  });

  it("rejects a replayed ticket", async () => {
    const base = await start({ authToken: TOKEN });
    const ticketResponse = await fetch(`${base}/api/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const { ticket } = (await ticketResponse.json()) as { ticket: string };
    await connect(base, `?ticket=${ticket}`);
    expect(await connect(base, `?ticket=${ticket}`)).toBe(401);
  });

  it("accepts an upgrade with no ticket when no token is configured (browser mode)", async () => {
    const base = await start({});
    expect(await connect(base, "")).toBe(200);
  });

  it("rejects a browser Origin outside the allowlist, even in browser mode", async () => {
    const base = await start({});
    expect(await connect(base, "", "/ws/rpc", { origin: "https://evil.example" })).toBe(403);
  });

  it("accepts a proxy-forwarded upgrade whose Host and Origin name an allowed host", async () => {
    // The tailscale-serve shape: the proxy preserves its public Host, and the
    // page it served connects back with the matching browser Origin. Allowing
    // the Host but rejecting the Origin would render the app without a
    // working WebSocket.
    const base = await start({ allowedHosts: ["proxy.ts.net"] });
    expect(
      await connect(base, "", "/ws/rpc", {
        headers: { host: "proxy.ts.net" },
        origin: "https://proxy.ts.net",
      }),
    ).toBe(200);
  });

  it("keeps rejecting unrelated Origins when allowed hosts are configured", async () => {
    const base = await start({ allowedHosts: ["proxy.ts.net"] });
    expect(await connect(base, "", "/ws/rpc", { origin: "https://evil.example" })).toBe(403);
  });
});

describe("createServer staged startup", () => {
  const ui: UIApp = Effect.succeed(HttpServerResponse.text("ok"));

  /** Records its disposal so a test can assert it ran, and ran exactly once. */
  function fakeRuntime(released: string[]): RpcRuntime {
    return {
      context: { "effect/context": Context.empty() } as unknown as RpcRuntime["context"],
      run: () => Promise.reject(new Error("fake runtime cannot run effects")),
      dispose: async () => {
        released.push("rpcRuntime");
      },
    };
  }

  it("disposes the RPC runtime exactly once when UI creation fails", async () => {
    const released: string[] = [];
    await expect(
      createServer(
        {},
        {
          createRpcRuntime: async () => fakeRuntime(released),
          createUI: () => Promise.reject(new Error("ui failed")),
          createRequestHandler: () => Promise.reject(new Error("unreachable")),
        },
      ),
    ).rejects.toThrow("ui failed");
    expect(released).toEqual(["rpcRuntime"]);
  });

  it("closes the request scope and the runtime when the request handler fails", async () => {
    const released: string[] = [];
    await expect(
      createServer(
        {},
        {
          createRpcRuntime: async () => fakeRuntime(released),
          createUI: async () => ui,
          createRequestHandler: async (_runtime, _app, requestScope) => {
            await Effect.runPromise(
              Scope.addFinalizer(
                requestScope,
                Effect.sync(() => released.push("requestScope")),
              ),
            );
            throw new Error("handler failed");
          },
        },
      ),
    ).rejects.toThrow("handler failed");
    expect(released).toEqual(["requestScope", "rpcRuntime"]);
  });

  it("releases the stages in reverse acquisition order, exactly once, on dispose", async () => {
    const released: string[] = [];
    const managed = await createServer(
      {},
      {
        createRpcRuntime: async () => fakeRuntime(released),
        createUI: async () => ui,
        createRequestHandler: async (_runtime, _app, requestScope) => {
          await Effect.runPromise(
            Scope.addFinalizer(
              requestScope,
              Effect.sync(() => released.push("requestScope")),
            ),
          );
          return () => {};
        },
      },
    );
    await new Promise<void>((resolve) => managed.listen(0, "127.0.0.1", resolve));
    managed.once("close", () => released.push("http"));

    await managed.dispose();
    await managed.dispose();

    expect(managed.listening).toBe(false);
    expect(released).toEqual(["http", "requestScope", "rpcRuntime"]);
  });
});
