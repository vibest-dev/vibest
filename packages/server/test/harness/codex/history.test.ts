import type { ThreadItem, Turn } from "@vibest/contract/codex/protocol/v2";
import { describe, expect, it } from "vitest";

import { turnsToUIMessages } from "../../../src/harness/codex/history";

const turn = (id: string, items: ReadonlyArray<unknown>): Turn =>
  ({
    id,
    items: items as Turn["items"],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  }) as Turn;

const userItem = (id: string, text: string): unknown => ({
  type: "userMessage",
  id,
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
});

const agentItem = (id: string, text: string): unknown => ({
  type: "agentMessage",
  id,
  text,
  phase: null,
  memoryCitation: null,
});

const commandItem = (id: string): ThreadItem =>
  ({
    type: "commandExecution",
    id,
    command: "ls",
    cwd: "/tmp",
  }) as unknown as ThreadItem;

describe("turnsToUIMessages", () => {
  it("folds a turn into a user message and one assistant message keyed by turn id", () => {
    const messages = turnsToUIMessages([
      turn("t1", [
        userItem("u1", "hello"),
        {
          type: "reasoning",
          id: "r1",
          summary: ["thinking about it"],
          content: [],
        },
        agentItem("a1", "hi there"),
      ]),
    ]);

    expect(messages).toEqual([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
      {
        id: "t1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking about it", state: "done" },
          { type: "text", text: "hi there", state: "done" },
        ],
      },
    ]);
  });

  it("maps tool items to settled generic tool parts with the whole item as input and output", () => {
    const command = commandItem("c1");
    const messages = turnsToUIMessages([turn("t1", [userItem("u1", "run ls"), command])]);

    expect(messages[1]?.parts).toEqual([
      {
        type: "tool-commandExecution",
        toolCallId: "c1",
        state: "output-available",
        input: command,
        output: command,
        providerExecuted: true,
      },
    ]);
  });

  it("routes mcp and dynamic tool calls to dynamic-tool parts", () => {
    const mcp = { type: "mcpToolCall", id: "m1", server: "s", tool: "t" } as unknown as ThreadItem;
    const messages = turnsToUIMessages([turn("t1", [mcp])]);

    expect(messages).toEqual([
      {
        id: "t1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "mcpToolCall",
            toolCallId: "m1",
            state: "output-available",
            input: mcp,
            output: mcp,
            providerExecuted: true,
          },
        ],
      },
    ]);
  });

  it("keeps one assistant message per turn across turns", () => {
    const messages = turnsToUIMessages([
      turn("t1", [userItem("u1", "first"), agentItem("a1", "one")]),
      turn("t2", [userItem("u2", "second"), agentItem("a2", "two")]),
    ]);

    expect(messages.map((message) => ({ id: message.id, role: message.role }))).toEqual([
      { id: "u1", role: "user" },
      { id: "t1", role: "assistant" },
      { id: "u2", role: "user" },
      { id: "t2", role: "assistant" },
    ]);
  });

  it("skips non-streamed item kinds and empty content, matching the live transform", () => {
    const messages = turnsToUIMessages([
      turn("t1", [
        userItem("u1", "go"),
        { type: "plan", id: "p1", text: "the plan" },
        { type: "hookPrompt", id: "h1", fragments: [] },
        { type: "contextCompaction", id: "cc1" },
        agentItem("a1", ""),
        { type: "reasoning", id: "r1", summary: [], content: [] },
        agentItem("a2", "done"),
      ]),
    ]);

    expect(messages).toEqual([
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      { id: "t1", role: "assistant", parts: [{ type: "text", text: "done", state: "done" }] },
    ]);
  });

  it("keeps a mid-turn steer input in item order without splitting the assistant message", () => {
    const messages = turnsToUIMessages([
      turn("t1", [
        userItem("u1", "start"),
        agentItem("a1", "working"),
        userItem("u2", "also do this"),
        agentItem("a2", "done both"),
      ]),
    ]);

    expect(messages.map((message) => message.id)).toEqual(["u1", "t1", "u2"]);
    expect(messages[1]?.parts).toEqual([
      { type: "text", text: "working", state: "done" },
      { type: "text", text: "done both", state: "done" },
    ]);
  });

  it("prefers raw reasoning content over the summary", () => {
    const messages = turnsToUIMessages([
      turn("t1", [{ type: "reasoning", id: "r1", summary: ["sum"], content: ["raw"] }]),
    ]);

    expect(messages[0]?.parts).toEqual([{ type: "reasoning", text: "raw", state: "done" }]);
  });
});
