import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CodexAgent } from "../../src/codex/agent";

const FAKE = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (f) => process.stdout.write(JSON.stringify(f) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "th_1" } } });
  if (msg.method === "turn/start") {
    if (msg.params.input[0].text === "crash") {
      // Die mid-turn: ack, stream a partial turn, then exit without completing.
      // The empty write's callback fires after the queued frames flush, so the
      // client is guaranteed to see them before the pipe closes.
      send({ id: msg.id, result: { turn: { id: "turn_2" } } });
      send({ method: "turn/started", params: { threadId: "th_1", turn: { id: "turn_2" } } });
      send({ method: "item/agentMessage/delta", params: { threadId: "th_1", itemId: "i1", delta: "po" } });
      process.stdout.write("", () => process.exit(1));
      return;
    }
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

describe("CodexAgent", () => {
  it("creates a thread and streams a full turn", async () => {
    const agent = new CodexAgent({ executablePath: makeFake() });
    const { sessionId } = await agent.session.create({ workspacePath: "/tmp" });
    expect(sessionId).toBe("th_1");
    const chunks: { type: string }[] = [];
    for await (const chunk of agent.session.prompt({ sessionId, text: "ping" })) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "data-turn/completed",
      "finish",
    ]);
    await agent.session.abort(sessionId);
  });

  it("surfaces an unexpected app-server exit as an error chunk", async () => {
    const agent = new CodexAgent({ executablePath: makeFake() });
    const { sessionId } = await agent.session.create({ workspacePath: "/tmp" });
    const chunks: { type: string; errorText?: string }[] = [];
    for await (const chunk of agent.session.prompt({ sessionId, text: "crash" })) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.type)).toEqual(["start", "text-start", "text-delta", "error"]);
    expect(chunks.at(-1)?.errorText).toContain("exited unexpectedly");
  });
});
