import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouterClient } from "@orpc/server";
import { CodexAgent } from "@vibest/harness/codex";
import { Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { ClaudeCodeLayer } from "../src/rpc/claude-code";
import { Codex } from "../src/rpc/codex";
import type { RpcContext } from "../src/rpc/context";
import { router } from "../src/rpc/router";

// Mirrors packages/harness/test/codex/agent.test.ts: a minimal `codex
// app-server` stand-in over stdio JSONL, exercised through the RPC router
// instead of the CodexAgent directly.
const FAKE = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (f) => process.stdout.write(JSON.stringify(f) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "th_1" } } });
  if (msg.method === "turn/start") {
    send({ id: msg.id, result: { turn: { id: "turn_1" } } });
    send({ method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_1" } } });
    send({ method: "item/started", params: { threadId: "th_1", item: { type: "agentMessage", id: "i1", text: "" } } });
    send({ method: "item/agentMessage/delta", params: { threadId: "th_1", itemId: "i1", delta: "pong" } });
    send({ method: "item/completed", params: { threadId: "th_1", item: { type: "agentMessage", id: "i1", text: "pong" } } });
    send({ method: "turn/completed", params: { threadId: "th_1", turn: { id: "turn_1", status: "completed" } } });
  }
  if (msg.method === "turn/interrupt" || msg.method === "thread/unsubscribe") send({ id: msg.id, result: null });
});
`;

function makeFake(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  const file = join(dir, "fake-codex.js");
  writeFileSync(file, FAKE);
  chmodSync(file, 0o755);
  return file;
}

describe("codex router", () => {
  it("creates a session and streams a prompt through router.codex", async () => {
    const testCodexLayer = Layer.sync(Codex, () => new CodexAgent({ executablePath: makeFake() }));
    const runtime = ManagedRuntime.make(Layer.merge(ClaudeCodeLayer, testCodexLayer));
    try {
      const context: RpcContext = {
        "effect/context": runtime.runSync(runtime.contextEffect),
      };
      const client = createRouterClient(router, { context });

      const { sessionId } = await client.codex.session.create({ workspacePath: "/tmp" });
      expect(sessionId).toBe("th_1");

      const chunks: { type: string }[] = [];
      for await (const chunk of await client.codex.prompt({ sessionId, text: "ping" })) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.at(-1)?.type).toBe("finish");

      await client.codex.session.abort({ sessionId });
    } finally {
      await runtime.dispose();
    }
  });
});
