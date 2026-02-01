import { ScrollArea } from "@vibest/ui/components/scroll-area";
import { Spinner } from "@vibest/ui/components/spinner";
import { AlertCircle, FileWarning } from "lucide-react";
import { lazy, Suspense } from "react";

import type { DiffFileInfo } from "../../types";

import { useFileDiff } from "../../hooks/use-file-diff";

const LazyMultiFileDiff = lazy(() =>
  import("@pierre/diffs/react").then((mod) => ({ default: mod.MultiFileDiff })),
);

interface SingleFileDiffProps {
  repoPath: string;
  file: DiffFileInfo;
}

export function SingleFileDiff({ repoPath, file }: SingleFileDiffProps) {
  const { data, isLoading, error } = useFileDiff({
    path: repoPath,
    filePath: file.path,
    staged: file.staged,
    enabled: true,
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-destructive flex h-full items-center justify-center gap-2">
        <AlertCircle className="size-4" />
        <span>Failed to load diff</span>
      </div>
    );
  }

  if (data?.error === "too_large") {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2">
        <FileWarning className="size-4" />
        <span>File too large to display (exceeds 1MB)</span>
      </div>
    );
  }

  if (data?.error === "binary") {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2">
        <FileWarning className="size-4" />
        <span>Binary file cannot be displayed</span>
      </div>
    );
  }

  if (data?.error === "not_found") {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2">
        <AlertCircle className="size-4" />
        <span>File not found</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* File header */}
      <div className="bg-muted/50 border-border flex items-center justify-between border-b px-4 py-2">
        <span className="font-mono text-sm">{file.path}</span>
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          {file.staged && (
            <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5">staged</span>
          )}
          <span className="text-success">+{file.insertions}</span>
          <span className="text-destructive">-{file.deletions}</span>
        </div>
      </div>

      {/* Diff content */}
      <ScrollArea className="flex-1">
        <Suspense fallback={<div className="flex justify-center p-4"><Spinner /></div>}>
          <LazyMultiFileDiff
            oldFile={{
              name: file.path,
              contents: data?.oldContent ?? "",
            }}
            newFile={{
              name: file.path,
              contents: data?.newContent ?? "",
            }}
            options={{
              themeType: "dark",
              diffStyle: "unified",
            }}
          />
        </Suspense>
      </ScrollArea>
    </div>
  );
}
