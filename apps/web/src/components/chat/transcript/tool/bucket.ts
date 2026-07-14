import type { ToolUIPart, UIMessage } from "ai";
import { isToolUIPart } from "ai";

// The five aggregation buckets. Order here is the order rendered in the
// trigger phrase (files → lists → searches → edits → commands).
export type BucketKey = "files" | "lists" | "searches" | "edits" | "commands";

export const BUCKET_ORDER: readonly BucketKey[] = [
  "files",
  "lists",
  "searches",
  "edits",
  "commands",
] as const;

// Provider-generic `part.type` → bucket, keyed by the AI-SDK tool-part type
// string. Tools NOT in this map still enter the accordion (see
// use-tool-batches) but stay silent in the trigger phrase. Subagent
// invocations opt out of batching entirely via `isStandalone`.
const TOOL_BUCKETS: Record<string, BucketKey> = {
  "tool-Read": "files",
  "tool-WebFetch": "files",
  "tool-Glob": "lists",
  "tool-Grep": "searches",
  "tool-WebSearch": "searches",
  "tool-Edit": "edits",
  "tool-Write": "edits",
  "tool-MultiEdit": "edits",
  "tool-NotebookEdit": "edits",
  "tool-Bash": "commands",
  "tool-BashOutput": "commands",
  "tool-KillShell": "commands",
  "tool-SlashCommand": "commands",
};

// Tools that opt OUT of batching and render as their own item. Subagent
// invocations carry a description and a nested message tree; collapsing them
// into a bucket count flattens that hierarchy.
const STANDALONE_TOOL_TYPES = new Set<string>(["tool-Task"]);

export function bucketFor(part: ToolUIPart): BucketKey | null {
  return TOOL_BUCKETS[part.type] ?? null;
}

export function isStandalone(type: string): boolean {
  return STANDALONE_TOOL_TYPES.has(type);
}

// The file identity a `files`/`edits` tool dedupes on. Reads the provider's
// typed `input` field; a single trust-boundary cast to the shape we read.
export function filePathOf(part: ToolUIPart): string | undefined {
  const input = part.input as { file_path?: unknown; notebook_path?: unknown } | undefined;
  switch (part.type) {
    case "tool-Read":
    case "tool-Edit":
    case "tool-Write":
    case "tool-MultiEdit": {
      const fp = input?.file_path;
      return typeof fp === "string" ? fp : undefined;
    }
    case "tool-NotebookEdit": {
      const np = input?.notebook_path;
      return typeof np === "string" ? np : undefined;
    }
    default:
      return undefined;
  }
}

// Claude Code streams a Task subagent's child tool calls as top-level parts
// tagged with the parent's toolUseId; they render inside the Task card, so the
// batching layer treats them as transparent. Provider knowledge kept at this
// trust boundary, not in the generic batcher.
export function isChildToolPart(part: UIMessage["parts"][number]): boolean {
  return (
    isToolUIPart(part) &&
    typeof (part.callProviderMetadata as { claudeCode?: { parentToolUseId?: unknown } } | undefined)
      ?.claudeCode?.parentToolUseId === "string"
  );
}
