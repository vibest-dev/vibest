import { Skeleton } from "@vibest/ui/components/skeleton";
import { ArrowDown, ArrowUp, Check, Circle, FileEdit, FilePlus } from "lucide-react";

import type { GitStatus } from "../../types";

interface WorktreeStatusProps {
  status: GitStatus | undefined;
  isLoading: boolean;
}

export function WorktreeStatus({ status, isLoading }: WorktreeStatusProps) {
  if (isLoading || !status) {
    return <Skeleton className="h-4 w-24 rounded" />;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status.clean ? (
        <span className="text-success inline-flex items-center gap-1 text-[11px] font-medium">
          <Check className="h-3 w-3" />
          Clean
        </span>
      ) : (
        <>
          {status.staged > 0 && (
            <span className="text-primary inline-flex items-center gap-1 text-[11px] font-medium">
              <Circle className="h-2 w-2 fill-current" />
              {status.staged} staged
            </span>
          )}
          {status.modified > 0 && (
            <span className="text-warning-foreground inline-flex items-center gap-1 text-[11px] font-medium">
              <FileEdit className="h-3 w-3" />
              {status.modified}
            </span>
          )}
          {status.untracked > 0 && (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px] font-medium">
              <FilePlus className="h-3 w-3" />
              {status.untracked}
            </span>
          )}
        </>
      )}

      {(status.ahead > 0 || status.behind > 0) && (
        <span className="text-muted-foreground/30">|</span>
      )}

      {status.ahead > 0 && (
        <span className="text-info-foreground inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums">
          <ArrowUp className="h-3 w-3" />
          {status.ahead}
        </span>
      )}
      {status.behind > 0 && (
        <span className="text-warning-foreground inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums">
          <ArrowDown className="h-3 w-3" />
          {status.behind}
        </span>
      )}
    </div>
  );
}
