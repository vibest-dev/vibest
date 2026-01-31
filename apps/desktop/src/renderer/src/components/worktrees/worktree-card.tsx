import { Button } from "@vibest/ui/components/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@vibest/ui/components/menu";
import {
  AlertTriangle,
  ArrowDownToLine,
  ExternalLink,
  Eye,
  FolderOpen,
  GitBranch,
  MoreVertical,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import type { Worktree } from "../../types";

import { useGitStatus } from "../../hooks/use-git-status";
import { client } from "../../lib/client";
import { cn } from "../../lib/utils";
import { WorktreeStatus } from "./worktree-status";

interface WorktreeCardProps {
  worktree: Worktree;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onViewChanges: (id: string) => void;
}

export function WorktreeCard({ worktree, onOpen, onRemove, onViewChanges }: WorktreeCardProps) {
  const isDeleted = !worktree.exists;
  const { status, isLoading, fetch, pull } = useGitStatus(isDeleted ? undefined : worktree.path);
  const [isFetching, setIsFetching] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const placeName = worktree.path.split("/").pop() || worktree.branch;
  const shortPath = worktree.path.replace(/^\/Users\/[^/]+/, "~");

  const handleFetch = async () => {
    if (isDeleted) return;
    setIsFetching(true);
    await fetch();
    setIsFetching(false);
  };

  const handlePull = async () => {
    if (isDeleted) return;
    setIsPulling(true);
    await pull();
    setIsPulling(false);
  };

  const handleOpenFinder = () => {
    if (isDeleted) return;
    client.fs.openFinder({ path: worktree.path });
  };

  const handleOpenTerminal = () => {
    if (isDeleted) return;
    client.fs.openTerminal({ path: worktree.path });
  };

  return (
    <article
      className={cn(
        "group bg-card relative rounded-xl border p-4 transition-all duration-200",
        isDeleted
          ? "border-destructive/30 bg-destructive/5"
          : "hover:border-border/80 border-border hover:shadow-md",
      )}
    >
      {/* Header */}
      <div className="mb-3 flex items-start justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
              isDeleted ? "bg-destructive/10" : "bg-muted",
            )}
          >
            {isDeleted ? (
              <AlertTriangle className="text-destructive h-4 w-4" />
            ) : (
              <GitBranch className="text-muted-foreground h-4 w-4" />
            )}
          </div>
          <div className="min-w-0 pt-0.5">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "truncate text-[13px] font-semibold",
                  isDeleted ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {placeName}
              </span>
            </div>
            <p className="text-muted-foreground mt-0.5 truncate text-[11px]">{worktree.branch}</p>
          </div>
        </div>

        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground h-6 w-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
                aria-label="Worktree options"
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            }
          />
          <MenuPopup side="bottom" align="end">
            {!isDeleted && (
              <>
                <MenuItem onClick={() => onOpen(worktree.id)}>
                  <FolderOpen className="h-4 w-4" />
                  Open in Editor
                </MenuItem>
                <MenuItem onClick={() => onViewChanges(worktree.id)}>
                  <Eye className="h-4 w-4" />
                  View Changes
                </MenuItem>
                <MenuItem onClick={handleOpenTerminal}>
                  <Terminal className="h-4 w-4" />
                  Open Terminal
                </MenuItem>
                <MenuItem onClick={handleOpenFinder}>
                  <ExternalLink className="h-4 w-4" />
                  Open in Finder
                </MenuItem>
                <MenuSeparator />
              </>
            )}
            <MenuItem variant="destructive" onClick={() => onRemove(worktree.id)}>
              <Trash2 className="h-4 w-4" />
              {isDeleted ? "Remove from List" : "Delete Worktree"}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      {/* Path */}
      <p
        className={cn(
          "mb-3 truncate font-mono text-[11px]",
          isDeleted ? "text-destructive/70" : "text-muted-foreground/70",
        )}
        title={worktree.path}
      >
        {shortPath}
      </p>

      {/* Status */}
      <div className="mb-4">
        {isDeleted ? (
          <span className="text-destructive text-[12px]">Worktree not found on disk</span>
        ) : (
          <WorktreeStatus status={status} isLoading={isLoading} />
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        {isDeleted ? (
          <Button
            variant="destructive"
            size="sm"
            className="h-8 flex-1 text-[12px] font-medium"
            onClick={() => onRemove(worktree.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              size="sm"
              className="h-8 flex-1 text-[12px] font-medium"
              onClick={() => onOpen(worktree.id)}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Open
            </Button>
            <Button
              variant="secondary"
              size="icon-sm"
              className="h-8 w-8"
              onClick={handleOpenTerminal}
              aria-label="Open Terminal"
            >
              <Terminal className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground h-8 w-8"
              onClick={handleFetch}
              disabled={isFetching}
              aria-label="Fetch"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground h-8 w-8"
              onClick={handlePull}
              disabled={isPulling}
              aria-label="Pull"
            >
              <ArrowDownToLine className={cn("h-3.5 w-3.5", isPulling && "animate-bounce")} />
            </Button>
          </>
        )}
      </div>
    </article>
  );
}
