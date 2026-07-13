import { isReasoningUIPart, isToolUIPart, type ToolUIPart } from "ai";

import { BUCKET_ORDER, bucketFor, filePathOf, type BucketKey } from "./tool/bucket";
import type { BatchPart } from "./use-tool-batches";

/**
 * Per-bucket counts split by tool state. A bucket appears in the trigger label
 * iff at least one of doneCount / runningCount is > 0.
 *
 * - `doneCount` counts tools whose state is terminal (`output-available` /
 *   `output-error`). Rendered with past tense ("Read 5 files").
 * - `runningCount` counts tools still in flight (`input-streaming` /
 *   `input-available`). Rendered with present tense ("Reading 1 file").
 */
export type BucketCount = {
  key: BucketKey;
  doneCount: number;
  runningCount: number;
};

export type BatchTriggerLabel = {
  kind: "aggregated";
  /** Buckets with doneCount + runningCount > 0, in BUCKET_ORDER. */
  buckets: BucketCount[];
};

function isToolRunning(part: ToolUIPart): boolean {
  return part.state === "input-streaming" || part.state === "input-available";
}

function toToolParts(parts: readonly BatchPart[]): ToolUIPart[] {
  return parts.filter((p): p is ToolUIPart => !isReasoningUIPart(p) && isToolUIPart(p));
}

function emptyIdentities(): Record<BucketKey, Set<string>> {
  return {
    files: new Set(),
    lists: new Set(),
    searches: new Set(),
    edits: new Set(),
    commands: new Set(),
  };
}

/**
 * Aggregate a batch's tool parts into a bucketed trigger label, splitting each
 * bucket into `doneCount` and `runningCount` based on each individual tool's
 * state. Provider-generic — bucket membership comes from `bucketFor`.
 *
 * Dedup rules:
 * - `files` / `edits` dedupe by file path (fallback to `toolCallId` when the
 *   path isn't streamed yet), per state.
 * - `lists` / `searches` / `commands` count by occurrence (per `toolCallId`).
 *
 * Reasoning parts are ignored.
 */
export function computeBatchTrigger(parts: readonly BatchPart[]): BatchTriggerLabel {
  const tools = toToolParts(parts);
  const doneIdentities = emptyIdentities();
  const runningIdentities = emptyIdentities();

  for (const part of tools) {
    const bucket = bucketFor(part);
    if (bucket == null) continue;
    const dedupKey =
      bucket === "files" || bucket === "edits"
        ? (filePathOf(part) ?? part.toolCallId)
        : part.toolCallId;
    const target = isToolRunning(part) ? runningIdentities : doneIdentities;
    target[bucket].add(dedupKey);
  }

  const buckets: BucketCount[] = BUCKET_ORDER.flatMap((key) => {
    const doneCount = doneIdentities[key].size;
    const runningCount = runningIdentities[key].size;
    return doneCount + runningCount > 0 ? [{ key, doneCount, runningCount }] : [];
  });

  return { kind: "aggregated", buckets };
}
