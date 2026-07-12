import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { readUIMessageStream } from "ai";
import { transform } from "./transform";
import type { ClaudeCodeUIMessage } from "./ui-message";
import type { ClaudeCodeUIMessageChunk } from "../types/envelope";

/** Cold-fold a native transcript into UIMessage[] via the same render transform as the live stream. */
export async function foldToUIMessages(
  messages: Iterable<SDKMessage>,
): Promise<ClaudeCodeUIMessage[]> {
  const stream = new ReadableStream<ClaudeCodeUIMessageChunk>({
    start(controller) {
      for (const message of messages) {
        for (const chunk of transform(message)) controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  // readUIMessageStream yields the evolving message(s); keep the final snapshot per id.
  const byId = new Map<string, ClaudeCodeUIMessage>();
  for await (const msg of readUIMessageStream({ stream })) {
    byId.set(msg.id, msg as ClaudeCodeUIMessage);
  }
  return [...byId.values()];
}
