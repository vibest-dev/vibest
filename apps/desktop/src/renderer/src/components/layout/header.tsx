import { Button } from "@vibest/ui/components/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@vibest/ui/components/menu";
import {
  ExternalLink,
  FolderGit2,
  MoreHorizontal,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";

import type { Repository } from "../../types";

import { client } from "../../lib/client";

interface HeaderProps {
  repository: Repository | null;
  onRemoveRepository: (repositoryId: string) => void;
  onRefresh: () => void;
}

export function Header({ repository, onRemoveRepository, onRefresh }: HeaderProps) {
  if (!repository) {
    return (
      <header className="border-border bg-background/50 app-drag-region flex h-12 items-center border-b px-5 backdrop-blur-sm">
        <span className="text-muted-foreground text-[13px]">
          Select a repository to view worktrees
        </span>
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
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground h-7 w-7"
                aria-label="More options"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            }
          />
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
