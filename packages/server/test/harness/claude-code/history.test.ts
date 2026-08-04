import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { sessionMessagesToUIMessages } from "../../../src/harness/claude-code/history";

const record = (over: {
  type: "user" | "assistant" | "system";
  uuid: string;
  message: unknown;
  parent_tool_use_id?: string | null;
  parent_agent_id?: string | null;
}): SessionMessage =>
  ({
    session_id: "s1",
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...over,
  }) as SessionMessage;

const userRecord = (uuid: string, content: unknown, over: Record<string, unknown> = {}) =>
  record({ type: "user", uuid, message: { role: "user", content }, ...over });

const assistantRecord = (
  uuid: string,
  content: ReadonlyArray<unknown>,
  over: Record<string, unknown> = {},
) => record({ type: "assistant", uuid, message: { role: "assistant", content }, ...over });

describe("sessionMessagesToUIMessages", () => {
  it("folds a text exchange into user and assistant messages keyed by uuid", () => {
    const messages = sessionMessagesToUIMessages([
      userRecord("u1", "hello"),
      assistantRecord("a1", [{ type: "text", text: "hi there" }]),
    ]);

    expect(messages).toEqual([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "hi there", state: "done" }],
      },
    ]);
  });

  it("folds a run of assistant records into one message and reopens on the next user input", () => {
    const messages = sessionMessagesToUIMessages([
      userRecord("u1", "first"),
      assistantRecord("a1", [{ type: "text", text: "one" }]),
      assistantRecord("a2", [{ type: "text", text: "two" }]),
      userRecord("u2", "second"),
      assistantRecord("a3", [{ type: "text", text: "three" }]),
    ]);

    expect(messages.map((message) => ({ id: message.id, role: message.role }))).toEqual([
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "u2", role: "user" },
      { id: "a3", role: "assistant" },
    ]);
    expect(messages[1]?.parts.map((part) => (part as { text?: string }).text)).toEqual([
      "one",
      "two",
    ]);
  });

  it("replaces a known tool call in place with its successful result", () => {
    const messages = sessionMessagesToUIMessages([
      userRecord("u1", "run it"),
      assistantRecord("a1", [
        { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } },
      ]),
      userRecord("u2", [{ type: "tool_result", tool_use_id: "c1", content: "ok" }]),
      assistantRecord("a2", [{ type: "text", text: "done" }]),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]?.parts[0]).toEqual({
      type: "tool-Bash",
      toolCallId: "c1",
      state: "output-available",
      input: { command: "ls" },
      output: undefined,
      providerExecuted: true,
    });
  });

  it("maps an error result to output-error with flattened text", () => {
    const messages = sessionMessagesToUIMessages([
      userRecord("u1", "run it"),
      assistantRecord("a1", [
        { type: "tool_use", id: "c1", name: "Bash", input: { command: "boom" } },
      ]),
      userRecord("u2", [
        {
          type: "tool_result",
          tool_use_id: "c1",
          is_error: true,
          content: [{ type: "text", text: "exit 1" }],
        },
      ]),
    ]);

    expect(messages[1]?.parts[0]).toMatchObject({
      type: "tool-Bash",
      state: "output-error",
      errorText: "exit 1",
    });
  });

  it("keeps an unanswered tool call input-available", () => {
    const messages = sessionMessagesToUIMessages([
      userRecord("u1", "run it"),
      assistantRecord("a1", [{ type: "tool_use", id: "c1", name: "Bash", input: {} }]),
    ]);

    expect(messages[1]?.parts[0]).toMatchObject({ type: "tool-Bash", state: "input-available" });
  });

  it("renders unknown tool names as dynamic-tool parts", () => {
    const messages = sessionMessagesToUIMessages([
      userRecord("u1", "go"),
      assistantRecord("a1", [
        { type: "tool_use", id: "c1", name: "mcp__custom__thing", input: { a: 1 } },
      ]),
      userRecord("u2", [{ type: "tool_result", tool_use_id: "c1", content: "fine" }]),
    ]);

    expect(messages[1]?.parts[0]).toMatchObject({
      type: "dynamic-tool",
      toolName: "mcp__custom__thing",
      state: "output-available",
    });
  });

  it("drops slash-command bookkeeping and caveat banners", () => {
    const messages = sessionMessagesToUIMessages([
      userRecord("u0", "Caveat: the messages below were generated"),
      userRecord("u1", "<command-name>/clear</command-name>"),
      userRecord("u2", "<local-command-stdout></local-command-stdout>"),
      userRecord("u3", [{ type: "text", text: "real question" }]),
      assistantRecord("a1", [{ type: "text", text: "answer" }]),
    ]);

    expect(messages.map((message) => message.id)).toEqual(["u3", "a1"]);
  });

  it("drops thinking blocks like the live transform does", () => {
    const messages = sessionMessagesToUIMessages([
      userRecord("u1", "think"),
      assistantRecord("a1", [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "text", text: "conclusion" },
      ]),
    ]);

    expect(messages[1]?.parts).toEqual([{ type: "text", text: "conclusion", state: "done" }]);
  });

  it("attributes subagent-side records to their parent tool call, not the transcript", () => {
    const messages = sessionMessagesToUIMessages([
      userRecord("u1", "delegate"),
      assistantRecord("a1", [
        { type: "tool_use", id: "task1", name: "Task", input: { prompt: "sub" } },
      ]),
      // Subagent's own conversation rides with parent_tool_use_id set: its user
      // record must not open a transcript message, and its assistant text must
      // carry the attribution metadata.
      userRecord("s-u1", "sub prompt", { parent_tool_use_id: "task1" }),
      assistantRecord("s-a1", [{ type: "text", text: "sub answer" }], {
        parent_tool_use_id: "task1",
      }),
      userRecord("u2", [{ type: "tool_result", tool_use_id: "task1", content: "sub answer" }], {
        parent_tool_use_id: "task1",
      }),
    ]);

    expect(messages.map((message) => message.id)).toEqual(["u1", "a1"]);
    const parts = messages[1]?.parts ?? [];
    expect(parts[0]).toMatchObject({
      type: "tool-Task",
      state: "output-available",
      providerMetadata: { claudeCode: { parentToolUseId: "task1" } },
    });
    expect(parts[1]).toMatchObject({
      type: "text",
      text: "sub answer",
      providerMetadata: { claudeCode: { parentToolUseId: "task1" } },
    });
  });

  it("skips nested-subagent records entirely", () => {
    const messages = sessionMessagesToUIMessages([
      userRecord("u1", "go"),
      assistantRecord("a1", [{ type: "text", text: "top" }]),
      assistantRecord("n1", [{ type: "text", text: "nested" }], { parent_agent_id: "agentX" }),
    ]);

    expect(messages[1]?.parts).toEqual([{ type: "text", text: "top", state: "done" }]);
  });
});
