/** Part-level subagent attribution. Spread into a chunk. */
export function subagentMetadata(parent: string | null) {
  return parent != null ? { providerMetadata: { claudeCode: { parentToolUseId: parent } } } : {};
}

/** Flatten tool_result content to a string; non-text blocks are JSON-serialized, not dropped. */
export function flattenToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block != null && typeof block === "object" && (block as { type?: unknown }).type === "text"
          ? String((block as { text?: unknown }).text ?? "")
          : JSON.stringify(block),
      )
      .join("\n");
  }
  return content != null ? JSON.stringify(content) : "";
}
