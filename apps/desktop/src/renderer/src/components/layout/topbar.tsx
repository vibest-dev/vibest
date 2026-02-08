import { Button } from "@vibest/ui/components/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@vibest/ui/components/menu";
import {
  Archive,
  CheckCircle2,
  Columns2,
  ExternalLink,
  FolderGit2,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";

import type { Repository, Task, Worktree } from "../../types";

import { client } from "../../lib/client";

interface TopbarProps {
  repository: Repository | null;
  task: Task | null;
  worktree: Worktree | null;
  onRemoveRepository: (repositoryId: string) => void;
  onEditTask: (task: Task) => void;
  onArchiveTask: (taskId: string) => void;
  onRefresh: () => void;
  showSidebarToggle?: boolean;
  onTogglePrimarySidebar?: () => void;
  canToggleSplit?: boolean;
  hasSecondarySplit?: boolean;
  onToggleSecondarySplit?: () => void;
}

export function Topbar({
  repository,
  task,
  worktree,
  onRemoveRepository,
  onEditTask,
  onArchiveTask,
  onRefresh,
  showSidebarToggle = false,
  onTogglePrimarySidebar,
  canToggleSplit = false,
  hasSecondarySplit = false,
  onToggleSecondarySplit,
}: TopbarProps) {
  const sidebarToggleButton = showSidebarToggle ? (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground hover:text-foreground h-7 w-7"
      onClick={onTogglePrimarySidebar}
      aria-label="Toggle primary sidebar"
    >
      <PanelLeft className="h-3.5 w-3.5" />
    </Button>
  ) : null;

  const splitToggleButton = canToggleSplit ? (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground hover:text-foreground h-7 w-7"
      onClick={onToggleSecondarySplit}
      aria-label={hasSecondarySplit ? "Close split" : "Open split"}
      title={hasSecondarySplit ? "Close split" : "Open split"}
    >
      <Columns2 className="h-3.5 w-3.5" />
    </Button>
  ) : null;

  if (task) {
    const handleOpenFinder = () => {
      if (worktree) {
        client.fs.openFinder({ path: worktree.path });
      }
    };

    const handleOpenTerminal = () => {
      if (worktree) {
        client.fs.openTerminal({ path: worktree.path });
      }
    };

    return (
      <header className="border-border bg-background/50 app-drag-region flex h-12 items-center justify-between border-b px-5 backdrop-blur-sm">
        <div className="app-no-drag flex min-w-0 items-center gap-3">
          {sidebarToggleButton}
          <div className="bg-accent flex h-7 w-7 items-center justify-center rounded-md">
            <CheckCircle2 className="text-accent-foreground h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h1 className="text-foreground truncate text-[13px] leading-tight font-semibold">
              {task.name}
            </h1>
            <p className="text-muted-foreground max-w-sm truncate text-[11px] leading-tight">
              {task.description || (worktree ? worktree.branch : "No description")}
            </p>
          </div>
        </div>

        <div className="app-no-drag flex items-center gap-0.5">
          {splitToggleButton}
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground h-7 w-7"
            onClick={onRefresh}
            aria-label="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>

          {worktree && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground h-7 w-7"
              onClick={handleOpenFinder}
              aria-label="Open in Finder"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}

          <Menu>
            <MenuTrigger
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-7 w-7 items-center justify-center rounded-md"
              aria-label="More options"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </MenuTrigger>
            <MenuPopup side="bottom" align="end">
              <MenuItem onClick={() => onEditTask(task)}>
                <Pencil className="h-4 w-4" />
                Edit Task
              </MenuItem>
              {worktree && (
                <>
                  <MenuSeparator />
                  <MenuItem onClick={handleOpenFinder}>
                    <ExternalLink className="h-4 w-4" />
                    Open in Finder
                  </MenuItem>
                  <MenuItem onClick={handleOpenTerminal}>
                    <Terminal className="h-4 w-4" />
                    Open Terminal
                  </MenuItem>
                </>
              )}
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => onArchiveTask(task.id)}>
                <Archive className="h-4 w-4" />
                Archive Task
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </header>
    );
  }

  if (!repository) {
    return (
      <header className="border-border bg-background/50 app-drag-region flex h-12 items-center justify-between border-b px-5 backdrop-blur-sm">
        <div className="app-no-drag flex items-center gap-2">
          {sidebarToggleButton}
          <span className="text-muted-foreground text-[13px]">Select a task to get started</span>
        </div>
        <div className="app-no-drag flex items-center gap-0.5">{splitToggleButton}</div>
      </header>
    );
  }

  const handleOpenFinder = () => {
    client.fs.openFinder({ path: repository.path });
  };

  const handleOpenTerminal = () => {
    client.fs.openTerminal({ path: repository.path });
  };

  return (
    <header className="border-border bg-background/50 app-drag-region flex h-12 items-center justify-between border-b px-5 backdrop-blur-sm">
      <div className="app-no-drag flex min-w-0 items-center gap-3">
        {sidebarToggleButton}
        <div className="bg-accent flex h-7 w-7 items-center justify-center rounded-md">
          <FolderGit2 className="text-accent-foreground h-4 w-4" />
        </div>
        <div className="min-w-0">
          <h1 className="text-foreground truncate text-[13px] leading-tight font-semibold">
            {repository.name}
          </h1>
          <p className="text-muted-foreground max-w-sm truncate font-mono text-[11px] leading-tight">
            {repository.path.replace(/^\/Users\/[^/]+/, "~")}
          </p>
        </div>
      </div>

      <div className="app-no-drag flex items-center gap-0.5">
        {splitToggleButton}
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground h-7 w-7"
          onClick={onRefresh}
          aria-label="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground h-7 w-7"
          onClick={handleOpenFinder}
          aria-label="Open in Finder"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>

        <Menu>
          <MenuTrigger
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-7 w-7 items-center justify-center rounded-md"
            aria-label="More options"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </MenuTrigger>
          <MenuPopup side="bottom" align="end">
            <MenuItem onClick={handleOpenFinder}>
              <ExternalLink className="h-4 w-4" />
              Open in Finder
            </MenuItem>
            <MenuItem onClick={handleOpenTerminal}>
              <Terminal className="h-4 w-4" />
              Open Terminal
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => onRemoveRepository(repository.id)}>
              <Trash2 className="h-4 w-4" />
              Remove Repository
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </header>
  );
}
