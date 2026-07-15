import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Stream } from "effect";

import type { ClaudeCodeUIMessageChunk } from "../../types/envelope";
import { createTransform } from "../transform";

export const toUIMessage = <E>(
  messages: Stream.Stream<SDKMessage, E>,
): Stream.Stream<ClaudeCodeUIMessageChunk, E> => {
  const transform = createTransform();
  return messages.pipe(
    Stream.map((message) => transform(message)),
    Stream.flattenIterable,
  );
};
