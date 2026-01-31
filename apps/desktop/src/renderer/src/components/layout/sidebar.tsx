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
import { Spinner } from "@vibest/ui/components/spinner";
import {
	ChevronRight,
	Download,
	FolderGit2,
	FolderPlus,
	GitBranch,
	Plus,
} from "lucide-react";
import type { Repository, Worktree } from "../../types";

interface SidebarProps {
	repositories: Repository[];
	worktreesByRepo: Record<string, Worktree[]>;
	selectedWorktreeId: string | null;
	expandedRepos: Set<string>;
	isLoading: boolean;
	onAddRepo: () => void;
	onCloneRepo: () => void;
	onCreateWorktree: (repositoryId: string) => void;
	onToggleRepo: (repoId: string, open: boolean) => void;
	onViewChanges: (worktree: Worktree) => void;
}

export function Sidebar({
	repositories,
	worktreesByRepo,
	selectedWorktreeId,
	expandedRepos,
	isLoading,
	onAddRepo,
	onCloneRepo,
	onCreateWorktree,
	onToggleRepo,
	onViewChanges,
}: SidebarProps) {
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
									<MenuItem onClick={onAddRepo}>
										<FolderPlus />
										Add Local Repository
									</MenuItem>
									<MenuItem onClick={onCloneRepo}>
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
								repositories.map((repo) => {
									const worktrees = worktreesByRepo[repo.id] ?? [];
									const hasWorktrees = worktrees.length > 0;

									return (
										<Collapsible
									key={repo.id}
									open={expandedRepos.has(repo.id)}
									onOpenChange={(open) => onToggleRepo(repo.id, open)}
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
																		? "size-4 transition-opacity duration-150 group-hover/menu-item:opacity-0"
																		: "size-4"
																}
															/>
															{hasWorktrees && (
																<ChevronRight className="size-4 absolute inset-0 opacity-0 transition-all duration-150 group-hover/menu-item:opacity-100 [[data-panel-open]_&]:rotate-90" />
															)}
														</span>
														<div className="flex flex-col items-start min-w-0 flex-1">
															<span className="truncate w-full">{repo.name}</span>
															<span className="truncate w-full text-xs text-muted-foreground font-normal">
																{repo.path?.replace(/^\/Users\/[^/]+/, "~") ?? ""}
															</span>
														</div>
														<button
															type="button"
															className="shrink-0 size-5 flex items-center justify-center rounded opacity-0 transition-opacity duration-150 group-hover/menu-item:opacity-100 hover:bg-sidebar-accent"
															onClick={(e) => {
																e.stopPropagation();
																onCreateWorktree(repo.id);
															}}
														>
															<Plus className="size-4" />
														</button>
													</SidebarMenuButton>
												</CollapsibleTrigger>
												<CollapsibleContent>
													<SidebarMenuSub>
														{worktrees.map((worktree) => (
															<SidebarMenuSubItem key={worktree.id}>
																<button
																	type="button"
																	onClick={() => onViewChanges(worktree)}
																	data-active={
																		selectedWorktreeId === worktree.id
																	}
																	className="-translate-x-px flex h-7 min-w-0 w-full items-center gap-2 overflow-hidden rounded-lg px-2 text-sidebar-foreground outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground text-sm"
																>
																	<GitBranch className="size-4 shrink-0" />
																	<span className="truncate">
																		{worktree.branch}
																	</span>
																</button>
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
		</SidebarProvider>
	);
}
