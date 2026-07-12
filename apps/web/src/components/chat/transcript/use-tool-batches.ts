import { isToolUIPart } from "ai";
import { useMemo } from "react";

import type { ClaudeCodeUIMessage } from "@/types";

type Part = ClaudeCodeUIMessage["parts"][number];

// Tools that render as their own full card instead of joining a batch.
const STANDALONE_TOOL_TYPES = new Set(["tool-Task"]);

export type RenderItem =
  | { kind: "tool-batch"; parts: Part[]; startIndex: number; isTrailing: boolean }
  | { kind: "passthrough"; part: Part; index: number };

// Task children stream in as top-level parts but render inside the Task card.
export function isChildToolPart(part: Part): boolean {
  return (
    isToolUIPart(part) && typeof part.callProviderMetadata?.claudeCode?.parentToolUseId === "string"
  );
}

// Slices a message's parts into runs of consecutive tool/reasoning work
// (rendered as one collapsible batch) and passthrough parts (text, standalone
// tool cards). Only the tail batch can still grow while streaming, so only it
// may shimmer.
export function batchToolParts(parts: readonly Part[]): RenderItem[] {
  const items: RenderItem[] = [];
  let pending: Part[] = [];
  let pendingStart = -1;

  const flushPending = (isTrailing: boolean) => {
    if (pending.length === 0) return;
    items.push({ kind: "tool-batch", parts: pending, startIndex: pendingStart, isTrailing });
    pending = [];
    pendingStart = -1;
  };

  for (const [index, part] of parts.entries()) {
    if (isChildToolPart(part)) continue;
    if (isToolUIPart(part) && STANDALONE_TOOL_TYPES.has(part.type)) {
      flushPending(false);
      items.push({ kind: "passthrough", part, index });
      continue;
    }
    if (isToolUIPart(part) || part.type === "reasoning") {
      if (pending.length === 0) pendingStart = index;
      pending.push(part);
      continue;
    }
    if (part.type === "text" && part.text.trim()) {
      flushPending(false);
      items.push({ kind: "passthrough", part, index });
      continue;
    }
    // Everything else (blank text, step markers, files we don't render) is
    // transparent: it must not split an ongoing batch.
  }
  flushPending(true);
  return items;
}

export function useToolBatches(parts: readonly Part[]): RenderItem[] {
  return useMemo(() => batchToolParts(parts), [parts]);
}
