import { skipToken, useQuery } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@vibest/ui/components/alert-dialog";
import { Button } from "@vibest/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vibest/ui/components/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@vibest/ui/components/menu";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarProvider,
  Sidebar as SidebarRoot,
} from "@vibest/ui/components/sidebar";
import {
  Archive,
  ChevronRight,
  Download,
  FolderGit2,
  FolderPlus,
  FolderSymlink,
  GitBranch,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { Repository, Worktree } from "../../types";

import { orpc } from "../../lib/orpc";
import { WorktreeDiffStats } from "../worktrees/worktree-diff-stats";

function getBasename(path: string): string {
  return path.split("/").pop() ?? path;
}

interface SidebarProps {
  repositories: Repository[];
  worktreesByRepository: Record<string, Worktree[]>;
  selectedWorktreeId: string | null;
  expandedRepositories: Set<string>;
  isLoading: boolean;
  onAddRepository: () => void;
  onCloneRepository: () => void;
  onCreateWorktree: (repositoryId: string) => void;
  onCreateWorktreeFrom: (repositoryId: string) => void;
  onToggleRepository: (repositoryId: string, open: boolean) => void;
  onViewChanges: (worktree: Worktree) => void;
  onArchiveWorktree: (worktreeId: string, commitFirst: boolean) => void;
}

export function Sidebar({
  repositories,
  worktreesByRepository,
  selectedWorktreeId,
  expandedRepositories,
  isLoading,
  onAddRepository,
  onCloneRepository,
  onCreateWorktree,
  onCreateWorktreeFrom,
  onToggleRepository,
  onViewChanges,
  onArchiveWorktree,
}: SidebarProps) {
  const [archiveTarget, setArchiveTarget] = useState<Worktree | null>(null);

  // Fetch git status for the archive target worktree using oRPC
  const { data: archiveTargetStatus } = useQuery(
    orpc.git.status.queryOptions({
      input: archiveTarget ? { path: archiveTarget.path } : skipToken,
    }),
  );

  const handleArchiveClick = (worktree: Worktree, e: React.MouseEvent) => {
    e.stopPropagation();
    // If worktree doesn't exist on disk, archive immediately (just remove from store)
    if (!worktree.exists) {
      onArchiveWorktree(worktree.id, false);
      return;
    }
    // Set the archive target to trigger status fetch
    setArchiveTarget(worktree);
  };

  // Show confirmation dialog only if there are uncommitted changes
  const showConfirmDialog =
    archiveTarget !== null && archiveTargetStatus !== undefined && !archiveTargetStatus.clean;

  // If status is loaded and clean, archive immediately
  useEffect(() => {
    if (archiveTarget !== null && archiveTargetStatus !== undefined && archiveTargetStatus.clean) {
      onArchiveWorktree(archiveTarget.id, false);
      setArchiveTarget(null);
    }
  }, [archiveTarget, archiveTargetStatus, onArchiveWorktree]);

  const handleConfirmArchive = () => {
    if (archiveTarget) {
      onArchiveWorktree(archiveTarget.id, true);
      setArchiveTarget(null);
    }
  };

  const archiveFolderName = archiveTarget ? getBasename(archiveTarget.path) : "";

  return (
    <SidebarProvider>
      <SidebarRoot collapsible="none">
        <SidebarHeader className="app-drag-region h-9" />

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel className="flex items-center justify-between">
              <span>Workspace</span>
              <Menu>
                <MenuTrigger
                  render={
                    <Button variant="ghost" size="icon" className="app-no-drag size-5">
                      <Plus className="size-4" />
                    </Button>
                  }
                />
                <MenuPopup side="right" align="start">
                  <MenuItem onClick={onAddRepository}>
                    <FolderPlus />
                    Add Local Repository
                  </MenuItem>
                  <MenuItem onClick={onCloneRepository}>
                    <Download />
                    Clone from URL
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </SidebarGroupLabel>

            <SidebarMenu>
              {!isLoading && repositories.length === 0 ? (
                <div className="px-2 py-8 text-center">
                  <FolderGit2 className="text-muted-foreground mx-auto mb-2" />
                  <p className="text-muted-foreground text-sm">No repositories</p>
                </div>
              ) : (
                repositories.map((repository) => {
                  const worktrees = worktreesByRepository[repository.id] ?? [];
                  const hasWorktrees = worktrees.length > 0;

                  return (
                    <Collapsible
                      key={repository.id}
                      open={expandedRepositories.has(repository.id)}
                      onOpenChange={(open) => onToggleRepository(repository.id, open)}
                    >
                      <SidebarMenuItem>
                        <CollapsibleTrigger disabled={!hasWorktrees} className="w-full">
                          <SidebarMenuButton className="h-auto w-full py-1.5">
                            <span className="relative flex size-4 shrink-0 items-center justify-center">
                              <FolderGit2
                                className={
                                  hasWorktrees
                                    ? "absolute inset-0 size-4 transition-all duration-200 ease-out group-hover/menu-item:scale-75 group-hover/menu-item:opacity-0"
                                    : "size-4"
                                }
                              />
                              {hasWorktrees && (
                                <ChevronRight className="absolute inset-0 size-4 scale-75 opacity-0 transition-all duration-200 ease-out group-hover/menu-item:scale-100 group-hover/menu-item:opacity-100 [[data-panel-open]_&]:rotate-90" />
                              )}
                            </span>
                            <div className="flex min-w-0 flex-1 flex-col items-start">
                              <span className="w-full truncate">{repository.name}</span>
                              <span className="text-muted-foreground w-full truncate text-xs font-normal">
                                {repository.path?.replace(/^\/Users\/[^/]+/, "~") ?? ""}
                              </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-0.5">
                              <button
                                type="button"
                                className="hover:bg-sidebar-accent flex size-5 items-center justify-center rounded opacity-0 transition-opacity duration-150 group-hover/menu-item:opacity-100"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onCreateWorktree(repository.id);
                                }}
                              >
                                <Plus className="size-4" />
                              </button>
                              <Menu>
                                <MenuTrigger
                                  render={
                                    <button
                                      type="button"
                                      className="hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent flex size-5 items-center justify-center rounded opacity-0 transition-opacity duration-150 group-hover/menu-item:opacity-100 data-[popup-open]:opacity-100"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <MoreHorizontal className="size-4" />
                                    </button>
                                  }
                                />
                                <MenuPopup side="right" align="start">
                                  <MenuItem onClick={() => onCreateWorktreeFrom(repository.id)}>
                                    <FolderSymlink />
                                    Create worktree from...
                                  </MenuItem>
                                </MenuPopup>
                              </Menu>
                            </div>
                          </SidebarMenuButton>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <SidebarMenuSub className="mr-0">
                            {worktrees.map((worktree) => (
                              <SidebarMenuSubItem key={worktree.id} className="group/worktree">
                                <div
                                  className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground relative flex h-10 w-full min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-lg text-sm"
                                  data-active={selectedWorktreeId === worktree.id}
                                >
                                  <button
                                    type="button"
                                    onClick={() => onViewChanges(worktree)}
                                    className="ring-sidebar-ring flex h-full min-w-0 flex-1 items-center gap-2 px-2 outline-hidden focus-visible:ring-2"
                                  >
                                    <GitBranch className="size-4 shrink-0" />
                                    <div className="flex min-w-0 flex-col items-start">
                                      <span className="truncate">{worktree.branch}</span>
                                      <span className="text-muted-foreground truncate text-xs font-normal">
                                        {getBasename(worktree.path)}
                                      </span>
                                    </div>
                                  </button>
                                  <WorktreeDiffStats path={worktree.path} />
                                  <button
                                    type="button"
                                    className="hover:bg-foreground/10 absolute right-1 flex size-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity duration-150 group-hover/worktree:opacity-100"
                                    onClick={(e) => handleArchiveClick(worktree, e)}
                                    title="Archive worktree"
                                  >
                                    <Archive className="size-3.5" />
                                  </button>
                                </div>
                              </SidebarMenuSubItem>
                            ))}
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </SidebarMenuItem>
                    </Collapsible>
                  );
                })
              )}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </SidebarRoot>

      <AlertDialog
        open={showConfirmDialog}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {archiveFolderName}</AlertDialogTitle>
            <AlertDialogDescription>
              This worktree has uncommitted changes. Archiving will commit all changes with a "WIP"
              message before removing the worktree and deleting the branch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={handleConfirmArchive}>Commit and archive</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SidebarProvider>
  );
}
