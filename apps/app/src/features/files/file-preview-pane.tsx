import { ORPCError } from "@orpc/client";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button } from "@vibest/ui/components/button";
import { Spinner } from "@vibest/ui/components/spinner";
import { cn } from "@vibest/ui/lib/utils";
import { RefreshCwIcon } from "lucide-react";
import { lazy, Suspense } from "react";

import { FileState } from "./file-state";

const FilePreviewAdapter = lazy(() =>
  import("./file-preview-adapter").then((module) => ({ default: module.FilePreviewAdapter })),
);

export function FilePreviewPane({
  file,
  path,
  line,
  navigationRequest,
  refreshing,
  onRefresh,
}: {
  file: UseQueryResult<string, Error>;
  path: string;
  line?: number;
  navigationRequest: number;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs" title={path}>
          {path}
        </span>
        <Button
          aria-label={`Reload ${path} and file tree`}
          disabled={refreshing}
          onClick={onRefresh}
          size="icon-xs"
          variant="ghost"
        >
          <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
      </div>
      {file.isPending ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner className="text-muted-foreground size-4" />
        </div>
      ) : file.isError ? (
        <FileState title={fileErrorTitle(file.error)} onRetry={() => void file.refetch()}>
          {fileErrorMessage(file.error)}
        </FileState>
      ) : (
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Spinner className="text-muted-foreground size-4" />
              </div>
            }
          >
            <FilePreviewAdapter
              content={file.data ?? ""}
              navigationRequest={navigationRequest}
              path={path}
              targetLine={line}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

function fileErrorTitle(error: Error): string {
  if (!(error instanceof ORPCError)) return "Unable to open file";
  switch (error.code) {
    case "NOT_FOUND":
      return "File no longer exists";
    case "BINARY_FILE":
      return "Binary preview unavailable";
    case "FILE_TOO_LARGE":
      return "File too large to preview";
    default:
      return "Unable to open file";
  }
}

function fileErrorMessage(error: Error): string {
  if (!(error instanceof ORPCError)) return error.message;
  switch (error.code) {
    case "NOT_FOUND":
      return "The file may have been moved or deleted. The Tab will remain open.";
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
    case "NOT_FILE":
      return "This path is not a regular file.";
    case "PATH_ESCAPE":
      return "This path resolves outside the project workspace.";
    case "READ_FAILED":
      return "The file may have moved, been deleted, or become unreadable.";
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
