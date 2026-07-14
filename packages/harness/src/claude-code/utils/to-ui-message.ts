import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeCodeUIMessageChunk } from "../../types/envelope";
import { createTransform } from "../transform";

export async function* toUIMessage(
  iterator: AsyncGenerator<SDKMessage, void, unknown>,
): AsyncGenerator<ClaudeCodeUIMessageChunk> {
  const transform = createTransform();
  for await (const message of iterator) {
    yield* transform(message);
  }
}
