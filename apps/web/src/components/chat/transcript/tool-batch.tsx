import { Shimmer } from "@vibest/ui/ai-elements/shimmer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vibest/ui/components/collapsible";
import { cn } from "@vibest/ui/lib/utils";
import type { ToolUIPart, UIMessage } from "ai";
import { ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { computeBatchTrigger, type BatchTriggerLabel } from "./compute-batch-trigger";
import { ToolPart } from "./tool-part";
import type { BucketKey } from "./tool/bucket";
import type { IndexedBatchPart } from "./use-tool-batches";

const BUCKET_PHRASES: Record<
  BucketKey,
  { done: (count: number) => string; active: (count: number) => string }
> = {
  files: {
    done: (n) => `Read ${n} ${plural(n, "file")}`,
    active: (n) => `Reading ${n} ${plural(n, "file")}`,
  },
  lists: {
    done: (n) => `Listed ${n} ${plural(n, "directory", "directories")}`,
    active: (n) => `Listing ${n} ${plural(n, "directory", "directories")}`,
  },
  searches: {
    done: (n) => `Ran ${n} ${plural(n, "search", "searches")}`,
    active: (n) => `Running ${n} ${plural(n, "search", "searches")}`,
  },
  edits: {
    done: (n) => `Edited ${n} ${plural(n, "file")}`,
    active: (n) => `Editing ${n} ${plural(n, "file")}`,
  },
  commands: {
    done: (n) => `Ran ${n} ${plural(n, "command")}`,
    active: (n) => `Running ${n} ${plural(n, "command")}`,
  },
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

// Pure phrase builder. Each bucket contributes up to two segments: done (past
// tense) first, then active (present tense).
function buildTriggerPhrase(label: BatchTriggerLabel): string {
  if (label.buckets.length === 0) return "Tool calls";
  const segments: string[] = [];
  for (const bucket of label.buckets) {
    if (bucket.doneCount > 0) segments.push(BUCKET_PHRASES[bucket.key].done(bucket.doneCount));
    if (bucket.runningCount > 0)
      segments.push(BUCKET_PHRASES[bucket.key].active(bucket.runningCount));
  }
  return segments.join(", ");
}

// Collapsible accordion for a run of consecutive tool/reasoning parts.
// shouldShimmer is computed by the parent from `isTrailing && isStreaming` —
// the batch stays agnostic of either signal alone. Reasoning parts stay in the
// batch data flow but never render — the trigger shimmer is the only thinking
// indicator we surface.
export function ToolBatch({
  message,
  parts,
  shouldShimmer = false,
  className,
}: {
  message: UIMessage;
  parts: IndexedBatchPart[];
  shouldShimmer?: boolean;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const batchParts = useMemo(() => parts.map((p) => p.part), [parts]);
  const label = useMemo(() => computeBatchTrigger(batchParts), [batchParts]);
  const phrase = useMemo(() => buildTriggerPhrase(label), [label]);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={cn("w-full", className)}>
      <CollapsibleTrigger
        className={cn(
          "text-muted-foreground hover:text-foreground -mx-1 flex w-full items-center gap-2 rounded-md px-1 text-sm transition-colors duration-150",
        )}
      >
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 transition-transform duration-150",
            isOpen ? "rotate-0" : "-rotate-90",
          )}
        />
        {shouldShimmer ? (
          <Shimmer duration={2} as="span">
            {phrase}
          </Shimmer>
        ) : (
          <span>{phrase}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 pt-2">
        {parts
          .filter(({ part }) => part.type !== "reasoning")
          .map(({ part }) => {
            const toolPart = part as ToolUIPart;
            return <ToolPart key={toolPart.toolCallId} message={message} part={toolPart} />;
          })}
      </CollapsibleContent>
    </Collapsible>
  );
}
