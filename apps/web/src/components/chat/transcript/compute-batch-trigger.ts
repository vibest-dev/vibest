import { isToolUIPart } from "ai";

import type { ClaudeCodeUIMessage } from "@/types";

type Part = ClaudeCodeUIMessage["parts"][number];

const BUCKET_ORDER = ["files", "searches", "edits", "commands", "other"] as const;

type BatchBucket = (typeof BUCKET_ORDER)[number];

const TOOL_BUCKETS: Partial<Record<string, BatchBucket>> = {
  "tool-Read": "files",
  "tool-WebFetch": "files",
  "tool-Glob": "searches",
  "tool-Grep": "searches",
  "tool-WebSearch": "searches",
  "tool-Edit": "edits",
  "tool-MultiEdit": "edits",
  "tool-Write": "edits",
  "tool-NotebookEdit": "edits",
  "tool-Bash": "commands",
  "tool-BashOutput": "commands",
  "tool-KillShell": "commands",
  "tool-SlashCommand": "commands",
};

const PHRASES: Record<
  BatchBucket,
  { done: (n: number) => string; running: (n: number) => string }
> = {
  files: {
    done: (n) => `Read ${n} ${plural(n, "file")}`,
    running: (n) => `Reading ${n} ${plural(n, "file")}`,
  },
  searches: {
    done: (n) => `Ran ${n} ${plural(n, "search", "searches")}`,
    running: (n) => `Running ${n} ${plural(n, "search", "searches")}`,
  },
  edits: {
    done: (n) => `Edited ${n} ${plural(n, "file")}`,
    running: (n) => `Editing ${n} ${plural(n, "file")}`,
  },
  commands: {
    done: (n) => `Ran ${n} ${plural(n, "command")}`,
    running: (n) => `Running ${n} ${plural(n, "command")}`,
  },
  other: {
    done: (n) => `${n} ${plural(n, "tool call")}`,
    running: (n) => `Running ${n} ${plural(n, "tool")}`,
  },
};

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

// Aggregates a batch's tool parts into a trigger phrase like
// "Read 3 files · Running 2 commands". files/edits dedupe by file path so a
// re-read of the same file counts once; a bucket with anything still running
// uses the present-tense phrase for its whole count. Returns null for a batch
// with no tool parts (reasoning only).
export function computeBatchTriggerLabel(parts: readonly Part[]): string | null {
  const counts = new Map<BatchBucket, { keys: Set<string>; running: boolean }>();
  for (const part of parts) {
    if (!isToolUIPart(part)) continue;
    const bucket = TOOL_BUCKETS[part.type] ?? "other";
    const key = bucket === "files" || bucket === "edits" ? dedupeKey(part) : part.toolCallId;
    const entry = counts.get(bucket) ?? { keys: new Set<string>(), running: false };
    entry.keys.add(key);
    if (part.state === "input-streaming" || part.state === "input-available") {
      entry.running = true;
    }
    counts.set(bucket, entry);
  }

  const phrases: string[] = [];
  for (const bucket of BUCKET_ORDER) {
    const entry = counts.get(bucket);
    if (!entry) continue;
    const phrase = entry.running ? PHRASES[bucket].running : PHRASES[bucket].done;
    phrases.push(phrase(entry.keys.size));
  }
  return phrases.length > 0 ? phrases.join(" · ") : null;
}

function dedupeKey(part: Part & { toolCallId: string; input?: unknown }): string {
  const input = part.input as { file_path?: string; notebook_path?: string } | undefined;
  return input?.file_path ?? input?.notebook_path ?? part.toolCallId;
}
