import {
  isDataUIPart,
  isReasoningUIPart,
  isToolUIPart,
  type ReasoningUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { useMemo } from "react";

import { isChildToolPart, isStandalone } from "./tool/bucket";

type Part = UIMessage["parts"][number];

export type BatchPart = ToolUIPart | ReasoningUIPart;

export type IndexedBatchPart = { part: BatchPart; index: number };

export type RenderItem =
  | {
      kind: "tool-batch";
      parts: IndexedBatchPart[];
      /**
       * True for the batch that ends at the tail of the message — there is no
       * non-tool / non-reasoning content after it, so the message might still
       * append more tools to this batch. False for batches already sealed by a
       * following text / file / data part. Callers AND-combine this with the
       * message-level streaming flag to decide whether to shimmer.
       */
      isTrailing: boolean;
    }
  | { kind: "passthrough"; part: Part; index: number };

// AI SDK stream-protocol control markers — emitted between content blocks and
// carrying no user-visible content. Transparent so they don't slice
// consecutive tool calls into one-tool batches.
const TRANSPARENT_CONTROL_TYPES = new Set<string>(["step-start", "step-finish"]);

function isTransparentControlPart(part: Part): boolean {
  return "type" in part && TRANSPARENT_CONTROL_TYPES.has(part.type);
}

function isStandaloneToolPart(part: Part): boolean {
  return "type" in part && isStandalone(part.type);
}

// Empty / whitespace-only text parts carry no user-visible content; treated as
// a breaker they would slice each step's tools into its own one-tool batch. A
// text part with real content still breaks the batch — that's the model
// actually saying something between tools.
function isBlankTextPart(part: Part): boolean {
  return part.type === "text" && part.text.trim() === "";
}

/**
 * Slice a message's parts into batched render items. Provider-generic.
 *
 * Batch rules:
 * - Consecutive tools (typed tool-*, dynamic-tool, unknown tools) and
 *   reasoning merge into one tool-batch.
 * - Exception: `isStandalone` tools (subagent invocations) flush the pending
 *   batch and render as their own passthrough.
 * - Subagent child tool calls (rendered inside their parent's card) are
 *   transparent.
 * - System data events (`data-*`), stream control markers
 *   (`step-start`/`step-finish`), and blank text parts are transparent —
 *   neither joining nor breaking the pending batch.
 * - Only visible, non-batchable parts (real text / file / standalone tool)
 *   break the batch, flushing it and appending a passthrough.
 */
export function batchToolParts(parts: readonly Part[]): RenderItem[] {
  const items: RenderItem[] = [];
  let pending: IndexedBatchPart[] = [];

  const flushPending = (isTrailing: boolean): void => {
    if (pending.length === 0) return;
    const hasTool = pending.some(({ part }) => isToolUIPart(part));
    if (hasTool) {
      items.push({ kind: "tool-batch", parts: pending, isTrailing });
    } else {
      for (const { part, index } of pending) {
        items.push({ kind: "passthrough", part: part as Part, index });
      }
    }
    pending = [];
  };

  for (const [index, part] of parts.entries()) {
    // Subagent child parts render inside the parent Task card, not here.
    if (isChildToolPart(part)) {
      continue;
    }
    // Standalone tool (subagent): seal the current batch and emit this tool as
    // its own passthrough. Checked before the generic tool branch because
    // these tools are still `isToolUIPart`-true.
    if (isStandaloneToolPart(part)) {
      flushPending(false);
      items.push({ kind: "passthrough", part, index });
      continue;
    }
    // Every other tool participates in batching, including dynamic-tool and
    // tools with no bucket mapping. Bucket-vs-no-bucket is purely a
    // trigger-phrase concern handled in compute-batch-trigger.ts.
    if (isToolUIPart(part) || isReasoningUIPart(part)) {
      pending.push({ part: part as BatchPart, index });
      continue;
    }
    // Transparent parts: skip without breaking pending.
    if (isDataUIPart(part) || isTransparentControlPart(part) || isBlankTextPart(part)) {
      continue;
    }
    // Mid-loop flush: this batch is followed by `part`, so it's sealed.
    flushPending(false);
    items.push({ kind: "passthrough", part, index });
  }

  // Final flush: the pending batch sits at the message tail with no content
  // following it, so it's the only one that can be trailing.
  flushPending(true);
  return items;
}

/** React hook: stable memo of `batchToolParts(parts)`. */
export function useToolBatches(parts: readonly Part[]): RenderItem[] {
  return useMemo(() => batchToolParts(parts), [parts]);
}
