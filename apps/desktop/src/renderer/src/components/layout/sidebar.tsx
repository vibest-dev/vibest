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
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuTrigger,
} from "@vibest/ui/components/menu";
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
import { orpc } from "../../lib/queries/workspace";
import type { Repository, Worktree } from "../../types";

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
		// Set the archive target to trigger status fetch
		setArchiveTarget(worktree);
	};

	// Show confirmation dialog only if there are uncommitted changes
	const showConfirmDialog =
		archiveTarget !== null &&
		archiveTargetStatus !== undefined &&
		!archiveTargetStatus.clean;

	// If status is loaded and clean, archive immediately
	useEffect(() => {
		if (
			archiveTarget !== null &&
			archiveTargetStatus !== undefined &&
			archiveTargetStatus.clean
		) {
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

	const archiveFolderName = archiveTarget
		? getBasename(archiveTarget.path)
		: "";

	return (
		<SidebarProvider>
			<SidebarRoot collapsible="none">
				<SidebarHeader className="h-9 app-drag-region" />

				<SidebarContent>
					<SidebarGroup>
						<SidebarGroupLabel className="flex items-center justify-between">
							<span>Workspace</span>
							<Menu>
								<MenuTrigger
									render={
										<Button
											variant="ghost"
											size="icon"
											className="app-no-drag size-5"
										>
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
								<div className="text-center py-8 px-2">
									<FolderGit2 className="mx-auto mb-2 text-muted-foreground" />
									<p className="text-sm text-muted-foreground">
										No repositories
									</p>
								</div>
							) : (
								repositories.map((repository) => {
									const worktrees = worktreesByRepository[repository.id] ?? [];
									const hasWorktrees = worktrees.length > 0;

									return (
										<Collapsible
											key={repository.id}
											open={expandedRepositories.has(repository.id)}
											onOpenChange={(open) =>
												onToggleRepository(repository.id, open)
											}
										>
											<SidebarMenuItem>
												<CollapsibleTrigger
													disabled={!hasWorktrees}
													className="w-full"
												>
													<SidebarMenuButton className="h-auto py-1.5 w-full">
														<span className="relative shrink-0 size-4 flex items-center justify-center">
															<FolderGit2
																className={
																	hasWorktrees
																		? "size-4 absolute inset-0 transition-all duration-200 ease-out group-hover/menu-item:opacity-0 group-hover/menu-item:scale-75"
																		: "size-4"
																}
															/>
															{hasWorktrees && (
																<ChevronRight className="size-4 absolute inset-0 opacity-0 scale-75 transition-all duration-200 ease-out group-hover/menu-item:opacity-100 group-hover/menu-item:scale-100 [[data-panel-open]_&]:rotate-90" />
															)}
														</span>
														<div className="flex flex-col items-start min-w-0 flex-1">
															<span className="truncate w-full">
																{repository.name}
															</span>
															<span className="truncate w-full text-xs text-muted-foreground font-normal">
																{repository.path?.replace(
																	/^\/Users\/[^/]+/,
																	"~",
																) ?? ""}
															</span>
														</div>
														<div className="shrink-0 flex items-center gap-0.5">
															<button
																type="button"
																className="size-5 flex items-center justify-center rounded opacity-0 transition-opacity duration-150 group-hover/menu-item:opacity-100 hover:bg-sidebar-accent"
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
																			className="size-5 flex items-center justify-center rounded opacity-0 transition-opacity duration-150 group-hover/menu-item:opacity-100 hover:bg-sidebar-accent data-[popup-open]:opacity-100 data-[popup-open]:bg-sidebar-accent"
																			onClick={(e) => e.stopPropagation()}
																		>
																			<MoreHorizontal className="size-4" />
																		</button>
																	}
																/>
																<MenuPopup side="right" align="start">
																	<MenuItem
																		onClick={() =>
																			onCreateWorktreeFrom(repository.id)
																		}
																	>
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
															<SidebarMenuSubItem
																key={worktree.id}
																className="group/worktree"
															>
																<div
																	className="-translate-x-px flex h-7 min-w-0 w-full items-center gap-2 overflow-hidden rounded-lg text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground text-sm"
																	data-active={
																		selectedWorktreeId === worktree.id
																	}
																>
																	<button
																		type="button"
																		onClick={() => onViewChanges(worktree)}
																		className="flex flex-1 min-w-0 items-center gap-2 px-2 h-full outline-hidden ring-sidebar-ring focus-visible:ring-2"
																	>
																		<GitBranch className="size-4 shrink-0" />
																		<span className="truncate">
																			{worktree.branch}
																		</span>
																	</button>
																	<button
																		type="button"
																		className="size-5 shrink-0 mr-1 flex items-center justify-center rounded opacity-0 transition-opacity duration-150 group-hover/worktree:opacity-100 hover:bg-foreground/10"
																		onClick={(e) =>
																			handleArchiveClick(worktree, e)
																		}
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
							This worktree has uncommitted changes. Archiving will commit all
							changes with a "WIP" message before removing the worktree and
							deleting the branch.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="outline" />}>
							Cancel
						</AlertDialogClose>
						<Button onClick={handleConfirmArchive}>Commit and archive</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</SidebarProvider>
	);
}
