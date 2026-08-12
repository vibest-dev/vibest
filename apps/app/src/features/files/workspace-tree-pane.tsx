import { ORPCError } from "@orpc/client";
import { Button } from "@vibest/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@vibest/ui/components/empty";
import { Spinner } from "@vibest/ui/components/spinner";
import { cn } from "@vibest/ui/lib/utils";
import { FilesIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { lazy, Suspense } from "react";

import type { WorkspaceTreeQuery } from "./use-workspace-tree";

const FileTreeAdapter = lazy(() =>
  import("./file-tree-adapter").then((module) => ({ default: module.FileTreeAdapter })),
);

export function WorkspaceTreePane({
  sessionId,
  workspaceName,
  workspacePath,
  tree,
  onOpenFile,
  onRefresh,
  refreshing,
}: {
  sessionId: string;
  workspaceName: string;
  workspacePath: string;
  tree: WorkspaceTreeQuery;
  onOpenFile: (path: string) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const hasTree = tree.data !== undefined;
  const isRefreshing = refreshing ?? tree.isFetching;
  const refresh = onRefresh ?? (() => void tree.refetch());

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate px-1 text-xs"
          title={workspacePath}
        >
          {workspaceName}
        </span>
        <Button
          aria-label={`Refresh files in ${workspaceName}`}
          disabled={isRefreshing}
          onClick={refresh}
          size="icon-xs"
          variant="ghost"
        >
          <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
        </Button>
      </div>

      {tree.isError && hasTree ? (
        <div className="text-destructive flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={treeErrorMessage(tree.error)}>
            Refresh failed; showing the previous file tree.
          </span>
          <Button onClick={refresh} size="xs" variant="ghost">
            Retry
          </Button>
        </div>
      ) : null}

      {tree.isPending ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner className="text-muted-foreground size-4" />
        </div>
      ) : tree.data === undefined ? (
        <Empty className="py-8 md:py-8">
          <EmptyMedia variant="icon">
            <TriangleAlertIcon />
          </EmptyMedia>
          <EmptyContent>
            <div>
              <EmptyTitle className="text-base">Unable to load files</EmptyTitle>
              <EmptyDescription>{treeErrorMessage(tree.error)}</EmptyDescription>
            </div>
            <Button onClick={refresh} size="sm" variant="outline">
              Try again
            </Button>
          </EmptyContent>
        </Empty>
      ) : tree.data.entries.length === 0 ? (
        <Empty className="py-8 md:py-8">
          <EmptyMedia variant="icon">
            <FilesIcon />
          </EmptyMedia>
          <EmptyContent>
            <div>
              <EmptyTitle className="text-base">No files</EmptyTitle>
              <EmptyDescription>This workspace contains no visible files.</EmptyDescription>
            </div>
          </EmptyContent>
        </Empty>
      ) : (
        <Suspense
          fallback={
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <Spinner className="text-muted-foreground size-4" />
            </div>
          }
        >
          <FileTreeAdapter
            entries={tree.data.entries}
            onOpenFile={onOpenFile}
            sessionId={sessionId}
          />
        </Suspense>
      )}
    </div>
  );
}

function treeErrorMessage(error: Error | null): string {
  if (error === null) return "The workspace file tree could not be loaded.";
  if (!(error instanceof ORPCError)) return error.message;
  switch (error.code) {
    case "NOT_DIRECTORY":
      return "The project workspace is no longer a directory.";
    case "PATH_ESCAPE":
      return "The project workspace path is invalid.";
    case "READ_FAILED":
      return "The workspace may have moved, been deleted, or become unreadable.";
    default:
      return error.message;
  }
}
