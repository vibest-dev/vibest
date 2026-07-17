import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createServer, type ManagedServer } from "./server";

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

describe("createServer WebSocket ticket", () => {
  async function connect(base: string, query: string, path = "/ws/rpc"): Promise<number> {
    const url = `${base.replace("http://", "ws://")}${path}${query}`;
    const socket = new WebSocket(url, "vibest");
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
});
