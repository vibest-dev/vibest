import { Spinner } from "@vibest/ui/components/spinner";
import { lazy, Suspense, useEffect, useRef } from "react";

import type { FileDiff } from "../../types";

const LazyMultiFileDiff = lazy(() =>
  import("@pierre/diffs/react").then((mod) => ({ default: mod.MultiFileDiff })),
);

interface DiffContentProps {
  files: FileDiff[];
  scrollToIndex: number | null;
}

export function DiffContent({ files, scrollToIndex }: DiffContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (scrollToIndex !== null && fileRefs.current.has(scrollToIndex)) {
      const element = fileRefs.current.get(scrollToIndex);
      element?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [scrollToIndex]);

  if (files.length === 0) {
    return null;
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-4 p-4">
      {files.map((file, index) => {
        const filename = file.newFile?.filename ?? file.oldFile?.filename ?? "unknown";

        return (
          <div
            key={filename}
            ref={(el) => {
              if (el) fileRefs.current.set(index, el);
            }}
            className="border-border overflow-hidden rounded-lg border"
          >
            <div className="bg-muted/50 border-border border-b px-3 py-2">
              <span className="font-mono text-sm">{filename}</span>
            </div>
            <Suspense fallback={<div className="flex justify-center p-4"><Spinner /></div>}>
              <LazyMultiFileDiff
                oldFile={
                  file.oldFile
                    ? { name: file.oldFile.filename, contents: file.oldFile.contents }
                    : { name: "", contents: "" }
                }
                newFile={
                  file.newFile
                    ? { name: file.newFile.filename, contents: file.newFile.contents }
                    : { name: "", contents: "" }
                }
                options={{
                  themeType: "dark",
                  diffStyle: "unified",
                }}
              />
            </Suspense>
          </div>
        );
      })}
    </div>
  );
}
