import { ORPCError } from "@orpc/client";
import type { GitFileDiff } from "@vibest/contract/git";
import { Spinner } from "@vibest/ui/components/spinner";
import { FileDiffIcon } from "lucide-react";
import { lazy, Suspense } from "react";

import { emptyReviewMessage } from "./review-file-status";
import { ReviewState } from "./review-state";
import type { GitDiffsQuery } from "./use-git-diffs";
import type { GitReviewQuery } from "./use-git-review";

const ReviewDiffAdapter = lazy(() =>
  import("./review-diff-adapter").then((module) => ({ default: module.ReviewDiffAdapter })),
);

export function ReviewDiffPane({
  review,
  diffs,
  path,
  locateRequest,
}: {
  review: GitReviewQuery;
  diffs: GitDiffsQuery;
  path?: string;
  locateRequest: number;
}) {
  if (review.data !== undefined && review.data.files.length === 0) {
    return (
      <ReviewState prominentIcon title="No changes to review">
        {emptyReviewMessage(review.data)}
      </ReviewState>
    );
  }

  if (diffs.some((diff) => diff.isPending)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner className="text-muted-foreground size-4" />
      </div>
    );
  }

  const loaded: GitFileDiff[] = [];
  let firstError: Error | undefined;
  for (const diff of diffs) {
    if (diff.data !== undefined) {
      loaded.push(diff.data);
      continue;
    }
    if (diff.isError && diff.error !== null && !isSkippedDiffError(diff.error)) {
      firstError ??= diff.error;
    }
  }

  if (loaded.length === 0 && firstError !== undefined) {
    return (
      <ReviewState title={diffErrorTitle(firstError)} onRetry={() => void review.refetch()}>
        {diffErrorMessage(firstError)}
      </ReviewState>
    );
  }

  if (loaded.length === 0) {
    return (
      <ReviewState icon={FileDiffIcon} prominentIcon title="Review changes">
        Select a changed file in the tree to jump to its diff.
      </ReviewState>
    );
  }

  return (
    <div className="min-h-0 flex-1">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner className="text-muted-foreground size-4" />
          </div>
        }
      >
        <ReviewDiffAdapter diffs={loaded} locatePath={path} locateRequest={locateRequest} />
      </Suspense>
    </div>
  );
}

function isSkippedDiffError(error: Error): boolean {
  return (
    error instanceof ORPCError && (error.code === "BINARY_FILE" || error.code === "FILE_TOO_LARGE")
  );
}

function diffErrorTitle(error: Error): string {
  if (!(error instanceof ORPCError)) return "Unable to load diff";
  switch (error.code) {
    case "NOT_FOUND":
      return "File is no longer in the review";
    case "BINARY_FILE":
      return "Binary preview unavailable";
    case "FILE_TOO_LARGE":
      return "File too large to preview";
    case "REF_NOT_FOUND":
      return "Compare branch not found";
    default:
      return "Unable to load diff";
  }
}

function diffErrorMessage(error: Error): string {
  if (!(error instanceof ORPCError)) return error.message;
  switch (error.code) {
    case "NOT_FOUND":
      return "The file may have been committed, reverted, or renamed. Refresh the review.";
    case "BINARY_FILE":
      return "Binary preview unavailable.";
    case "FILE_TOO_LARGE": {
      const data = error.data as { size?: number; limit?: number } | undefined;
      const size = data?.size;
      const limit = data?.limit;
      if (size !== undefined && limit !== undefined) {
        return `${formatBytes(size)} exceeds the ${formatBytes(limit)} preview limit.`;
      }
      return "File too large to preview.";
    }
    case "PATH_ESCAPE":
      return "This path resolves outside the project workspace.";
    case "REF_NOT_FOUND":
      return "Pick a local branch or a remote-tracking ref that already exists.";
    default:
      return error.message;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kibibytes = bytes / 1024;
  if (kibibytes < 1024) return `${kibibytes.toFixed(1)} KiB`;
  return `${(kibibytes / 1024).toFixed(1)} MiB`;
}
