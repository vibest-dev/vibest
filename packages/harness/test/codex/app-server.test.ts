import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CodexAppServer } from "../../src/codex/app-server";

const FAKE = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { serverInfo: { name: "fake" } } });
  } else if (msg.method === "echo") {
    send({ id: msg.id, result: msg.params });
  } else if (msg.method === "boom") {
    send({ id: msg.id, error: { code: -1, message: "kaboom" } });
  } else if (msg.method === "notifyMe") {
    send({ id: msg.id, result: null });
    send({ method: "turn/started", params: { threadId: "th", turn: { id: "t1" } } });
  } else if (msg.method === "askMe") {
    send({ id: msg.id, result: null });
    send({ method: "item/commandExecution/requestApproval", id: 999, params: { threadId: "th" } });
  }
});
`;

function makeFake(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  const file = join(dir, "fake-codex.js");
  writeFileSync(file, FAKE);
  chmodSync(file, 0o755);
  return file;
}

describe("CodexAppServer", () => {
  const servers: CodexAppServer[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  async function started(handlers = {}) {
    const server = new CodexAppServer({ executablePath: makeFake(), handlers });
    servers.push(server);
    server.start();
    await server.initialize({ name: "vibest", title: "Vibest", version: "0.0.0" });
    return server;
  }

  it("correlates request/response", async () => {
    const server = await started();
    await expect(server.request("echo", { a: 1 })).resolves.toEqual({ a: 1 });
  });

  it("rejects with CodexRpcError on error frames", async () => {
    const server = await started();
    await expect(server.request("boom")).rejects.toMatchObject({ code: -1, message: "kaboom" });
  });

  it("routes notifications", async () => {
    const seen: unknown[] = [];
    const server = await started({ onNotification: (n: unknown) => seen.push(n) });
    await server.request("notifyMe");
    await new Promise((r) => setTimeout(r, 100));
    expect(seen[0]).toMatchObject({ method: "turn/started" });
  });

  it("answers server requests via onServerRequest", async () => {
    const server = await started({ onServerRequest: async () => ({ decision: "decline" }) });
    await server.request("askMe");
    await new Promise((r) => setTimeout(r, 100));
    // no assertion beyond "did not crash": the reply frame is consumed by the fake
    await server.close();
  });
});
