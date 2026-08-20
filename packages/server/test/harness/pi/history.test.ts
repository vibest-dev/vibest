import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { readUIMessageStream, type UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";

import { entriesToUIMessages } from "../../../src/harness/pi/history";
import type { AgentSessionEvent } from "../../../src/harness/pi/protocol";
import { createPiTransform } from "../../../src/harness/pi/transform";
import type { PiUIMessage, PiUIMessageChunk } from "../../../src/harness/pi/ui-message";

const entry = (value: unknown) => value as SessionEntry;

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

const userEntry = (id: string, parentId: string | null, content: unknown) =>
  entry({
    type: "message",
    id,
    parentId,
    timestamp: "t",
    message: { role: "user", content, timestamp: 0 },
  });

const assistantMessage = (content: unknown[], over: Record<string, unknown> = {}) => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "m1",
  usage,
  stopReason: "stop",
  timestamp: 0,
  ...over,
});

const assistantEntry = (
  id: string,
  parentId: string | null,
  content: unknown[],
  over: Record<string, unknown> = {},
) =>
  entry({
    type: "message",
    id,
    parentId,
    timestamp: "t",
    message: assistantMessage(content, over),
  });

const toolResultEntry = (id: string, parentId: string, over: Record<string, unknown>) =>
  entry({
    type: "message",
    id,
    parentId,
    timestamp: "t",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [],
      details: {},
      isError: false,
      timestamp: 0,
      ...over,
    },
  });

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

function comparableParts(parts: ReadonlyArray<object> | undefined): object[] {
  return (parts ?? []).map((part) => {
    const compact: Record<string, unknown> = Object.fromEntries(
      Object.entries(part).filter(([, value]) => value !== undefined),
    );
    if (compact.type === "reasoning" || compact.type === "text") {
      delete compact.id;
    }
    return compact;
  });
}

describe("entriesToUIMessages", () => {
  it("folds a single turn into a user and an assistant message", () => {
    const messages = entriesToUIMessages(
      [userEntry("u1", null, "hi"), assistantEntry("a1", "u1", [{ type: "text", text: "hello" }])],
      "a1",
      "s1",
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      id: "u1",
      role: "user",
      metadata: { sessionId: "s1" },
      parts: [{ type: "text", text: "hi" }],
    });
    expect(messages[1]).toEqual({
      id: "a1",
      role: "assistant",
      metadata: { sessionId: "s1", model: "m1", provider: "anthropic", stopReason: "stop", usage },
      parts: [{ type: "text", text: "hello", state: "done" }],
    });
  });

  it("returns empty history when the leaf is null or the chain is broken", () => {
    const entries = [userEntry("u1", "ghost", "hi")];
    expect(entriesToUIMessages(entries, null, "s1")).toEqual([]);
    expect(entriesToUIMessages(entries, "missing", "s1")).toEqual([]);
    expect(entriesToUIMessages(entries, "u1", "s1")).toEqual([]);
  });

  it("rebuilds only the branch that leads to the leaf", () => {
    const messages = entriesToUIMessages(
      [
        userEntry("u1", null, "hi"),
        assistantEntry("a1", "u1", [{ type: "text", text: "kept" }]),
        assistantEntry("a2", "u1", [{ type: "text", text: "forked away" }]),
      ],
      "a1",
      "s1",
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]?.parts).toEqual([{ type: "text", text: "kept", state: "done" }]);
  });

  it("maps user images to file parts", () => {
    const messages = entriesToUIMessages(
      [
        userEntry("u1", null, [
          { type: "text", text: "look" },
          { type: "image", data: "AAA", mimeType: "image/png" },
        ]),
      ],
      "u1",
      "s1",
    );
    expect(messages[0]?.parts).toEqual([
      { type: "text", text: "look" },
      { type: "file", mediaType: "image/png", url: "data:image/png;base64,AAA" },
    ]);
  });

  it("maps plaintext thinking to reasoning and drops encrypted (empty) thinking", () => {
    const messages = entriesToUIMessages(
      [
        userEntry("u1", null, "hi"),
        assistantEntry("a1", "u1", [
          { type: "thinking", thinking: "", thinkingSignature: "opaque" },
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "hello" },
        ]),
      ],
      "a1",
      "s1",
    );
    expect(messages[1]?.parts).toEqual([
      { type: "reasoning", text: "hm", state: "done" },
      { type: "text", text: "hello", state: "done" },
    ]);
  });

  it("carries textSignature into the part's providerMetadata", () => {
    const messages = entriesToUIMessages(
      [
        userEntry("u1", null, "hi"),
        assistantEntry("a1", "u1", [{ type: "text", text: "hello", textSignature: "sig" }]),
      ],
      "a1",
      "s1",
    );
    expect(messages[1]?.parts).toEqual([
      {
        type: "text",
        text: "hello",
        state: "done",
        providerMetadata: { pi: { textSignature: "sig" } },
      },
    ]);
  });

  it("pairs a toolCall with its result into an output-available part", () => {
    const messages = entriesToUIMessages(
      [
        userEntry("u1", null, "run ls"),
        assistantEntry("a1", "u1", [toolCall("c1", "bash", { command: "ls" })]),
        toolResultEntry("tr1", "a1", { content: [{ type: "text", text: "ok" }] }),
      ],
      "tr1",
      "s1",
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]?.parts).toEqual([
      {
        type: "tool-bash",
        toolCallId: "c1",
        state: "output-available",
        input: { command: "ls" },
        output: { content: [{ type: "text", text: "ok" }], details: {} },
        providerExecuted: true,
      },
    ]);
  });

  it("maps error results to output-error with the text-block errorText", () => {
    const messages = entriesToUIMessages(
      [
        userEntry("u1", null, "run"),
        assistantEntry("a1", "u1", [toolCall("c1", "bash", { command: "boom" })]),
        toolResultEntry("tr1", "a1", { content: [{ type: "text", text: "nope" }], isError: true }),
      ],
      "tr1",
      "s1",
    );
    expect(messages[1]?.parts).toEqual([
      {
        type: "tool-bash",
        toolCallId: "c1",
        state: "output-error",
        input: { command: "boom" },
        errorText: "nope",
        providerExecuted: true,
      },
    ]);
  });

  it("leaves an orphan toolCall input-available", () => {
    const messages = entriesToUIMessages(
      [
        userEntry("u1", null, "run"),
        assistantEntry("a1", "u1", [toolCall("c1", "bash", { command: "ls" })]),
      ],
      "a1",
      "s1",
    );
    expect(messages[1]?.parts).toEqual([
      {
        type: "tool-bash",
        toolCallId: "c1",
        state: "input-available",
        input: { command: "ls" },
        providerExecuted: true,
      },
    ]);
  });

  it("marks extension tools as dynamic-tool parts", () => {
    const messages = entriesToUIMessages(
      [
        userEntry("u1", null, "run"),
        assistantEntry("a1", "u1", [toolCall("c2", "my_ext_tool", {})]),
        toolResultEntry("tr1", "a1", {
          toolCallId: "c2",
          toolName: "my_ext_tool",
          content: [{ type: "text", text: "ok" }],
        }),
      ],
      "tr1",
      "s1",
    );
    expect(messages[1]?.parts).toEqual([
      {
        type: "dynamic-tool",
        toolName: "my_ext_tool",
        toolCallId: "c2",
        state: "output-available",
        input: {},
        output: { content: [{ type: "text", text: "ok" }], details: {} },
        providerExecuted: true,
      },
    ]);
  });

  it("folds a run of assistant and toolResult entries into one message", () => {
    const messages = entriesToUIMessages(
      [
        userEntry("u1", null, "go"),
        assistantEntry("a1", "u1", [
          { type: "text", text: "step 1" },
          toolCall("c1", "bash", { command: "ls" }),
        ]),
        toolResultEntry("tr1", "a1", { content: [{ type: "text", text: "ok" }] }),
        assistantEntry("a2", "tr1", [{ type: "text", text: "step 2" }], { model: "m2" }),
      ],
      "a2",
      "s1",
    );
    expect(messages).toHaveLength(2);
    // messageId is the segment's first assistant entry; metadata is the last's.
    expect(messages[1]?.id).toBe("a1");
    expect(messages[1]?.metadata?.model).toBe("m2");
    expect(messages[1]?.parts.map((part) => part.type)).toEqual(["text", "tool-bash", "text"]);
  });

  it("opens a new segment per user entry (steer shape)", () => {
    const messages = entriesToUIMessages(
      [
        userEntry("u1", null, "go"),
        assistantEntry("a1", "u1", [{ type: "text", text: "working" }]),
        userEntry("u2", "a1", "actually, stop"),
        assistantEntry("a2", "u2", [{ type: "text", text: "stopped" }]),
      ],
      "a2",
      "s1",
    );
    expect(messages.map((message) => ({ id: message.id, role: message.role }))).toEqual([
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "u2", role: "user" },
      { id: "a2", role: "assistant" },
    ]);
  });

  it("completes a call whose result lands after a steer-injected user entry", () => {
    const messages = entriesToUIMessages(
      [
        userEntry("u1", null, "go"),
        assistantEntry("a1", "u1", [toolCall("c1", "bash", { command: "ls" })]),
        userEntry("u2", "a1", "steer"),
        toolResultEntry("tr1", "u2", { content: [{ type: "text", text: "ok" }] }),
      ],
      "tr1",
      "s1",
    );
    expect(messages).toHaveLength(3);
    expect(messages[1]?.parts[0]).toMatchObject({ state: "output-available" });
  });

  it("skips bookkeeping entries and non-transcript message roles", () => {
    const noise = (type: string, id: string, parentId: string, over: Record<string, unknown>) =>
      entry({ type, id, parentId, timestamp: "t", ...over });
    const messages = entriesToUIMessages(
      [
        userEntry("u1", null, "hi"),
        noise("model_change", "n1", "u1", { provider: "openai", modelId: "gpt" }),
        noise("thinking_level_change", "n2", "n1", { thinkingLevel: "high" }),
        noise("custom", "n3", "n2", { customType: "ext" }),
        noise("label", "n4", "n3", { targetId: "u1", label: "mark" }),
        noise("session_info", "n5", "n4", { name: "renamed" }),
        noise("compaction", "n6", "n5", { summary: "s", firstKeptEntryId: "u1", tokensBefore: 1 }),
        noise("branch_summary", "n7", "n6", { fromId: "u1", summary: "s" }),
        noise("custom_message", "n8", "n7", { customType: "ext", content: "shown", display: true }),
        entry({
          type: "message",
          id: "n9",
          parentId: "n8",
          timestamp: "t",
          message: { role: "bashExecution", command: "ls", output: "", timestamp: 0 },
        }),
        assistantEntry("a1", "n9", [{ type: "text", text: "hello" }]),
      ],
      "a1",
      "s1",
    );
    expect(messages.map((message) => message.id)).toEqual(["u1", "a1"]);
  });

  it("matches the live transform's folded message part-for-part (no steer)", async () => {
    const transform = createPiTransform("s1");
    const event = (value: unknown) => value as AgentSessionEvent;
    const update = (assistantMessageEvent: Record<string, unknown>) =>
      event({ type: "message_update", message: assistantMessage([]), assistantMessageEvent });
    const liveEvents: AgentSessionEvent[] = [
      event({ type: "agent_start" }),
      update({ type: "start" }),
      update({ type: "thinking_start", contentIndex: 0 }),
      update({ type: "thinking_delta", contentIndex: 0, delta: "hm" }),
      update({ type: "thinking_end", contentIndex: 0, content: "hm" }),
      update({ type: "text_start", contentIndex: 1 }),
      update({ type: "text_delta", contentIndex: 1, delta: "hi " }),
      update({ type: "text_delta", contentIndex: 1, delta: "there" }),
      update({ type: "text_end", contentIndex: 1, content: "hi there" }),
      event({
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "bash",
        args: { command: "ls" },
      }),
      event({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "ok" }], details: {} },
        isError: false,
      }),
      event({
        type: "tool_execution_start",
        toolCallId: "c2",
        toolName: "my_ext_tool",
        args: {},
      }),
      event({
        type: "tool_execution_end",
        toolCallId: "c2",
        toolName: "my_ext_tool",
        result: { content: [{ type: "text", text: "nope" }], details: {} },
        isError: true,
      }),
      update({ type: "start" }),
      update({ type: "text_start", contentIndex: 0 }),
      update({ type: "text_delta", contentIndex: 0, delta: "done" }),
      update({ type: "text_end", contentIndex: 0, content: "done" }),
      event({ type: "agent_settled" }),
    ];
    const chunks: PiUIMessageChunk[] = liveEvents.flatMap((liveEvent) => [...transform(liveEvent)]);
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    let live: PiUIMessage | undefined;
    for await (const message of readUIMessageStream<PiUIMessage>({ stream })) {
      live = message;
    }

    const history = entriesToUIMessages(
      [
        userEntry("u1", null, "go"),
        assistantEntry("a1", "u1", [
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "hi there" },
          toolCall("c1", "bash", { command: "ls" }),
          toolCall("c2", "my_ext_tool", {}),
        ]),
        toolResultEntry("tr1", "a1", { content: [{ type: "text", text: "ok" }] }),
        toolResultEntry("tr2", "tr1", {
          toolCallId: "c2",
          toolName: "my_ext_tool",
          content: [{ type: "text", text: "nope" }],
          isError: true,
        }),
        assistantEntry("a2", "tr2", [{ type: "text", text: "done" }]),
      ],
      "a2",
      "s1",
    );

    expect(history).toHaveLength(2);
    // `readUIMessageStream` (ai 7.0.66) now materializes optional fields as
    // `undefined` and keeps stream block ids on reasoning parts. History
    // constructs settled parts directly, so compare the shared fold shape.
    expect(comparableParts(history[1]?.parts)).toEqual(comparableParts(live?.parts));
  });
});
