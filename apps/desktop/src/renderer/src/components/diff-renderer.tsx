import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@vibest/ui/components/empty";
import { FileDiff as FileDiffIcon } from "lucide-react";

import type { DiffFileInfo } from "../types";

import { useAppStoreShallow } from "../stores/app-store";
import { SingleFileDiff } from "./worktrees/single-file-diff";

interface DiffRendererProps {
  partId: string;
  isVisible: boolean;
}

function isDiffFileInfo(value: unknown): value is DiffFileInfo {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<DiffFileInfo>;
  return (
    typeof c.path === "string" &&
    typeof c.staged === "boolean" &&
    typeof c.insertions === "number" &&
    typeof c.deletions === "number"
  );
}

export function DiffRenderer({ partId, isVisible }: DiffRendererProps) {
  const partState = useAppStoreShallow((s) => s.workbench.parts.find((p) => p.id === partId));

  if (!isVisible) return null;

  const state = partState?.state as { file?: unknown; repoPath?: string } | undefined;

  if (!state?.file || !isDiffFileInfo(state.file) || !state.repoPath) {
    return (
      <Empty className="h-full">
        <EmptyMedia variant="icon">
          <FileDiffIcon />
        </EmptyMedia>
        <EmptyTitle>Select a file</EmptyTitle>
        <EmptyDescription>
          Pick a file from the secondary sidebar to inspect diff.
        </EmptyDescription>
      </Empty>
    );
  }

  return <SingleFileDiff repoPath={state.repoPath} file={state.file} />;
}
