import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { readUIMessageStream } from "ai";
import { Effect } from "effect";

import { ClaudeSdkError } from "../runtime/errors";
import type { ClaudeCodeUIMessageChunk } from "../types/envelope";
import { createTransform } from "./transform";
import type { ClaudeCodeUIMessage } from "./ui-message";

/** Cold-fold a native transcript through the same render transform as the live stream. */
export const foldToUIMessages = (
  messages: Iterable<SDKMessage>,
): Effect.Effect<ClaudeCodeUIMessage[], ClaudeSdkError> =>
  Effect.tryPromise({
    try: async () => {
      const transform = createTransform();
      const stream = new ReadableStream<ClaudeCodeUIMessageChunk>({
        start(controller) {
          for (const message of messages) {
            for (const chunk of transform(message)) controller.enqueue(chunk);
          }
          controller.close();
        },
      });

      const byId = new Map<string, ClaudeCodeUIMessage>();
      for await (const message of readUIMessageStream({ stream })) {
        byId.set(message.id, message as ClaudeCodeUIMessage);
      }
      return [...byId.values()];
    },
    catch: (cause) => new ClaudeSdkError({ operation: "fold-ui-messages", cause }),
  });
