import { ORPCError } from "@orpc/client";
import type { GitReviewFile } from "@vibest/contract/git";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@vibest/ui/components/empty";
import { Spinner } from "@vibest/ui/components/spinner";
import { FilesIcon, TriangleAlertIcon } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";

import { reviewGitStatusEntries } from "./review-file-status";
import { unionDeletedReviewEntries } from "./review-tree";
import type { WorkspaceTreeQuery } from "./use-workspace-tree";

const ReviewTreeAdapter = lazy(() =>
  import("./review-tree-adapter").then((module) => ({ default: module.ReviewTreeAdapter })),
);

export function ReviewTreePane({
  sessionId,
  workspaceName,
  workspacePath,
  tree,
  files,
  onSelectFile,
}: {
  sessionId: string;
  workspaceName: string;
  workspacePath: string;
  tree: WorkspaceTreeQuery;
  files: ReadonlyArray<GitReviewFile>;
  onSelectFile: (path: string) => void;
}) {
  const entries = useMemo(
    () => (tree.data === undefined ? [] : unionDeletedReviewEntries(tree.data.entries, files)),
    [files, tree.data],
  );
  const gitStatus = useMemo(() => reviewGitStatusEntries(files), [files]);

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate px-1 text-xs"
          title={workspacePath}
        >
          {workspaceName}
        </span>
      </div>

      {tree.isError && tree.data !== undefined ? (
        <div className="text-destructive flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={treeErrorMessage(tree.error)}>
            Refresh failed; showing the previous file tree.
          </span>
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
          </EmptyContent>
        </Empty>
      ) : entries.length === 0 ? (
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
          <ReviewTreeAdapter
            entries={entries}
            gitStatus={gitStatus}
            onSelectFile={onSelectFile}
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
