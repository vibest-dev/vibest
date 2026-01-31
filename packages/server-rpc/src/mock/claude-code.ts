import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UIDataTypes, UIMessage } from "ai";
import type { ClaudeCodeTools } from "ai-sdk-agents/claude-code";

import { implement } from "@orpc/server";
import { pushable, toUIMessage } from "ai-sdk-agents/claude-code";
import { createReadStream } from "node:fs";
import path from "node:path";
import JsonlParser from "stream-json/jsonl/Parser";

import { claudeCodeContract } from "../contract/claude-code";

type SDKJsonlMessage = SDKMessage & {
  sessionId: string;
  isSidechain: boolean;
};

async function* readJSONLFile(filePath: string) {
  const fileStream = createReadStream(filePath, { encoding: "utf8" });
  const pipeline = fileStream.pipe(JsonlParser.parser());

  const push = pushable<SDKJsonlMessage>();

  pipeline.on("data", (data: { key: number; value: SDKJsonlMessage }) => {
    push.push(data.value);
  });

  pipeline.on("end", () => {
    push.end();
  });

  pipeline.on("error", (error) => {
    console.error("Error parsing JSONL:", error);
    push.end();
  });

  for await (const message of push) {
    if (!message.isSidechain) {
      yield message;
    }
  }
}

export const promptImplement = implement(claudeCodeContract.prompt).handler(async function* () {
  try {
    const dirname = import.meta.dirname;
    const filePath = path.resolve(dirname, "response3.jsonl");
    const uiMessages = toUIMessage<UIMessage<undefined, UIDataTypes, ClaudeCodeTools>>(
      readJSONLFile(filePath),
    );
    for await (const message of uiMessages) {
      yield message;
    }
  } catch (error) {
    console.error("Error reading JSONL file", error);
    throw error;
  }
});
