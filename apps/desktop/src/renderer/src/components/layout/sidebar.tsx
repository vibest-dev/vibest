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
	Menu,
	MenuItem,
	MenuPopup,
	MenuTrigger,
} from "@vibest/ui/components/menu";
import {
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuItem,
	SidebarProvider,
	Sidebar as SidebarRoot,
} from "@vibest/ui/components/sidebar";
import {
	Archive,
	CheckCircle2,
	Download,
	FolderGit2,
	FolderPlus,
	MoreHorizontal,
	Plus,
	Settings,
	Tags,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { orpc } from "../../lib/orpc";
import { cn } from "../../lib/utils";
import { useAppStore } from "../../stores";
import type { Label, Repository, Task, Worktree } from "../../types";
import { ThemeToggle } from "../theme-toggle";
import { WorktreeDiffStats } from "../worktrees/worktree-diff-stats";

interface TaskWithWorktrees {
	task: Task;
	worktrees: Worktree[];
}

interface SidebarProps {
	repositories: Repository[];
	selectedTaskId: string | null;
	isLoading: boolean;
	onAddRepository: () => void;
	onCloneRepository: () => void;
	onCreateTask: (repositoryId: string) => void;
	onSelectTask: (task: Task, worktree: Worktree | null) => void;
	onArchiveTask: (taskId: string, commitFirst: boolean) => void;
	onManageLabels: (repositoryId: string) => void;
}

// Label color dot component
function LabelDots({
	labels,
	repositoryLabels,
}: {
	labels: string[];
	repositoryLabels: Label[];
}) {
	const taskLabels = repositoryLabels.filter((l) => labels.includes(l.id));
	if (taskLabels.length === 0) return null;

	return (
		<div className="flex gap-0.5">
			{taskLabels.slice(0, 3).map((label) => (
				<span
					key={label.id}
					className="size-2 rounded-full"
					style={{ backgroundColor: `#${label.color}` }}
					title={label.name}
				/>
			))}
			{taskLabels.length > 3 && (
				<span className="text-muted-foreground text-[10px]">
					+{taskLabels.length - 3}
				</span>
			)}
		</div>
	);
}

// Task list item component
function TaskListItem({
	taskWithWorktrees,
	repositoryLabels,
	isSelected,
	onSelect,
	onArchive,
}: {
	taskWithWorktrees: TaskWithWorktrees;
	repositoryLabels: Label[];
	isSelected: boolean;
	onSelect: () => void;
	onArchive: (e: React.MouseEvent) => void;
}) {
	const { task, worktrees } = taskWithWorktrees;
	const worktree = worktrees[0]; // For 1:1, just use first worktree

	return (
		<SidebarMenuItem className="group/task">
			<div
				className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground relative flex h-10 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg text-sm"
				data-active={isSelected}
			>
				<button
					type="button"
					onClick={onSelect}
					className="ring-sidebar-ring flex h-full min-w-0 flex-1 items-center gap-2 px-2 outline-hidden focus-visible:ring-2"
				>
					<CheckCircle2 className="size-4 shrink-0" />
					<div className="flex min-w-0 flex-1 flex-col items-start">
						<span className="truncate">{task.name}</span>
						{worktree && (
							<span className="text-muted-foreground truncate text-xs font-normal">
								{worktree.branch}
							</span>
						)}
					</div>
					<LabelDots labels={task.labels} repositoryLabels={repositoryLabels} />
				</button>
				{worktree && <WorktreeDiffStats path={worktree.path} />}
				<button
					type="button"
					className="hover:bg-foreground/10 absolute right-1 flex size-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity duration-150 group-hover/task:opacity-100"
					onClick={onArchive}
					title="Archive task"
				>
					<Archive className="size-3.5" />
				</button>
			</div>
		</SidebarMenuItem>
	);
}

// Repo tabs component with dynamic overflow
function RepoTabs({
	repositories,
	selectedRepositoryId,
	onSelectRepository,
	onAddRepository,
	onCloneRepository,
	className,
}: {
	repositories: Repository[];
	selectedRepositoryId: string | null;
	onSelectRepository: (id: string) => void;
	onAddRepository: () => void;
	onCloneRepository: () => void;
	className?: string;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const measureRef = useRef<HTMLDivElement>(null);
	const [visibleCount, setVisibleCount] = useState(repositories.length);

	// Calculate how many tabs fit in the container using hidden measurement container
	const calculateVisibleTabs = useCallback(() => {
		const container = containerRef.current;
		const measureContainer = measureRef.current;
		if (!container || !measureContainer) return;

		// Get available width (container width minus add button and padding)
		const containerWidth = container.offsetWidth;
		const addButtonWidth = 28; // size-5 + gap
		const moreButtonWidth = 40; // estimated width for "+N" button
		const availableWidth = containerWidth - addButtonWidth - 8; // 8px for gaps

		// Measure each tab's width from the hidden measurement container
		const tabs =
			measureContainer.querySelectorAll<HTMLSpanElement>("[data-measure-tab]");
		let totalWidth = 0;
		let count = 0;

		for (const tab of tabs) {
			const tabWidth = tab.offsetWidth + 2; // 2px for gap
			const needsMoreButton = count < repositories.length - 1;
			if (
				totalWidth + tabWidth + (needsMoreButton ? moreButtonWidth : 0) <=
				availableWidth
			) {
				totalWidth += tabWidth;
				count++;
			} else {
				break;
			}
		}

		setVisibleCount(Math.max(1, count)); // Show at least 1 tab
	}, [repositories.length]);

	// Recalculate on mount and when repositories change
	useLayoutEffect(() => {
		calculateVisibleTabs();
	}, [calculateVisibleTabs, repositories]);

	// Recalculate on resize
	useEffect(() => {
		const observer = new ResizeObserver(calculateVisibleTabs);
		if (containerRef.current) {
			observer.observe(containerRef.current);
		}
		return () => observer.disconnect();
	}, [calculateVisibleTabs]);

	const visibleRepos = repositories.slice(0, visibleCount);
	const overflowRepos = repositories.slice(visibleCount);

	return (
		<div
			ref={containerRef}
			className={cn("flex items-center gap-0.5 px-2", className)}
		>
			{/* Hidden measurement container - renders all tabs to measure their widths */}
			<div
				ref={measureRef}
				aria-hidden="true"
				className="pointer-events-none invisible absolute flex items-center gap-0.5"
			>
				{repositories.map((repo) => (
					<span
						key={repo.id}
						data-measure-tab
						className="shrink-0 rounded px-1.5 py-0.5 text-sm font-medium whitespace-nowrap"
					>
						{repo.name}
					</span>
				))}
			</div>

			{/* Visible tabs */}
			<div className="flex min-w-0 flex-1 items-center gap-0.5">
				{visibleRepos.map((repo) => (
					<button
						key={repo.id}
						type="button"
						onClick={() => onSelectRepository(repo.id)}
						className={cn(
							"shrink-0 truncate rounded px-1.5 py-0.5 text-sm font-medium transition-colors",
							selectedRepositoryId === repo.id
								? "bg-accent text-accent-foreground"
								: "text-muted-foreground hover:bg-muted hover:text-foreground",
						)}
						title={repo.path}
					>
						{repo.name}
					</button>
				))}
				{overflowRepos.length > 0 && (
					<Menu>
						<MenuTrigger
							render={
								<button
									type="button"
									className="text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 rounded px-1.5 py-0.5 text-sm font-medium transition-colors"
								>
									+{overflowRepos.length}
								</button>
							}
						/>
						<MenuPopup side="bottom" align="start">
							{overflowRepos.map((repo) => (
								<MenuItem
									key={repo.id}
									onClick={() => onSelectRepository(repo.id)}
								>
									{repo.name}
								</MenuItem>
							))}
						</MenuPopup>
					</Menu>
				)}
			</div>
			<Menu>
				<MenuTrigger
					render={
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded transition-colors"
						>
							<Plus className="size-3.5" />
						</button>
					}
				/>
				<MenuPopup side="bottom" align="end">
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
		</div>
	);
}

export function Sidebar({
	repositories,
	selectedTaskId,
	isLoading,
	onAddRepository,
	onCloneRepository,
	onCreateTask,
	onSelectTask,
	onArchiveTask,
	onManageLabels,
}: SidebarProps) {
	const [archiveTaskTarget, setArchiveTaskTarget] =
		useState<TaskWithWorktrees | null>(null);

	// Get selected repository from store
	const selectedRepositoryId = useAppStore((s) => s.selectedRepositoryId);
	const selectRepository = useAppStore((s) => s.selectRepository);

	// Auto-select first repository if none selected
	useEffect(() => {
		if (repositories.length > 0 && !selectedRepositoryId) {
			selectRepository(repositories[0].id);
		}
		// Handle stale selection (repo was deleted)
		if (
			selectedRepositoryId &&
			!repositories.find((r) => r.id === selectedRepositoryId)
		) {
			selectRepository(repositories[0]?.id ?? null);
		}
	}, [repositories, selectedRepositoryId, selectRepository]);

	// Get selected repository
	const selectedRepository =
		repositories.find((r) => r.id === selectedRepositoryId) ?? null;

	// Fetch tasks for selected repository
	const { data: tasksData } = useQuery(
		orpc.task.list.queryOptions({
			input: selectedRepositoryId
				? { repositoryId: selectedRepositoryId }
				: skipToken,
		}),
	);

	const tasksWithWorktrees = tasksData ?? [];
	const repositoryLabels = selectedRepository?.labels ?? [];

	// Fetch git status for archive task target
	const { data: archiveTaskTargetStatus } = useQuery(
		orpc.git.status.queryOptions({
			input: archiveTaskTarget?.worktrees[0]
				? { path: archiveTaskTarget.worktrees[0].path }
				: skipToken,
		}),
	);

	const handleArchiveTaskClick = (
		taskWithWorktrees: TaskWithWorktrees,
		e: React.MouseEvent,
	) => {
		e.stopPropagation();
		const worktree = taskWithWorktrees.worktrees[0];
		// If no worktree or doesn't exist, archive immediately
		if (!worktree || !worktree.exists) {
			onArchiveTask(taskWithWorktrees.task.id, false);
			return;
		}
		setArchiveTaskTarget(taskWithWorktrees);
	};

	const showTaskConfirmDialog =
		archiveTaskTarget !== null &&
		archiveTaskTargetStatus !== undefined &&
		!archiveTaskTargetStatus.clean;

	// If status is loaded and clean, archive immediately
	useEffect(() => {
		if (
			archiveTaskTarget !== null &&
			archiveTaskTargetStatus !== undefined &&
			archiveTaskTargetStatus.clean
		) {
			onArchiveTask(archiveTaskTarget.task.id, false);
			setArchiveTaskTarget(null);
		}
	}, [archiveTaskTarget, archiveTaskTargetStatus, onArchiveTask]);

	const handleConfirmArchiveTask = () => {
		if (archiveTaskTarget) {
			onArchiveTask(archiveTaskTarget.task.id, true);
			setArchiveTaskTarget(null);
		}
	};

	const archiveTaskName = archiveTaskTarget?.task.name ?? "";

	return (
		<SidebarProvider className="h-full min-h-0">
			<SidebarRoot collapsible="none">
				<SidebarHeader className="app-drag-region relative shrink-0 pt-9 pb-8">
					{/* Repo Tabs - fixed at top, doesn't scroll */}
					{!isLoading && repositories.length > 0 && (
						<RepoTabs
							className="app-no-drag absolute right-0 bottom-0 left-0 pb-1"
							repositories={repositories}
							selectedRepositoryId={selectedRepositoryId}
							onSelectRepository={selectRepository}
							onAddRepository={onAddRepository}
							onCloneRepository={onCloneRepository}
						/>
					)}
				</SidebarHeader>

				<SidebarContent>
					{/* Empty state when no repos */}
					{!isLoading && repositories.length === 0 && (
						<div className="px-2 py-8 text-center">
							<FolderGit2 className="text-muted-foreground mx-auto mb-2 size-8" />
							<p className="text-muted-foreground mb-3 text-sm">
								No repositories
							</p>
							<div className="flex justify-center gap-2">
								<Button variant="outline" size="sm" onClick={onAddRepository}>
									<FolderPlus className="size-4" />
									Add
								</Button>
								<Button variant="outline" size="sm" onClick={onCloneRepository}>
									<Download className="size-4" />
									Clone
								</Button>
							</div>
						</div>
					)}

					{/* Task list for selected repo */}
					{selectedRepository && (
						<SidebarGroup>
							<div className="flex items-center justify-between px-2 pb-1">
								<span className="text-muted-foreground text-sm font-medium">
									Tasks
								</span>
								<div className="flex items-center gap-0.5">
									<button
										type="button"
										className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-5 items-center justify-center rounded transition-colors"
										onClick={() => onCreateTask(selectedRepository.id)}
										title="Create task"
									>
										<Plus className="size-4" />
									</button>
									<Menu>
										<MenuTrigger
											render={
												<button
													type="button"
													className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-5 items-center justify-center rounded transition-colors"
												>
													<MoreHorizontal className="size-4" />
												</button>
											}
										/>
										<MenuPopup side="right" align="start">
											<MenuItem
												onClick={() => onManageLabels(selectedRepository.id)}
											>
												<Tags />
												Manage labels
											</MenuItem>
										</MenuPopup>
									</Menu>
								</div>
							</div>

							<SidebarMenu>
								{tasksWithWorktrees.length === 0 ? (
									<div className="px-2 py-6 text-center">
										<CheckCircle2 className="text-muted-foreground mx-auto mb-2 size-6" />
										<p className="text-muted-foreground text-xs">
											No tasks yet
										</p>
										<Button
											variant="ghost"
											size="sm"
											className="mt-2"
											onClick={() => onCreateTask(selectedRepository.id)}
										>
											<Plus className="size-4" />
											Create task
										</Button>
									</div>
								) : (
									tasksWithWorktrees.map((taskWithWorktrees) => (
										<TaskListItem
											key={taskWithWorktrees.task.id}
											taskWithWorktrees={taskWithWorktrees}
											repositoryLabels={repositoryLabels}
											isSelected={selectedTaskId === taskWithWorktrees.task.id}
											onSelect={() => {
												const worktree = taskWithWorktrees.worktrees[0];
												onSelectTask(taskWithWorktrees.task, worktree ?? null);
											}}
											onArchive={(e) =>
												handleArchiveTaskClick(taskWithWorktrees, e)
											}
										/>
									))
								)}
							</SidebarMenu>
						</SidebarGroup>
					)}
				</SidebarContent>

				<SidebarFooter className="!flex-row items-center justify-between">
					<button
						type="button"
						className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors"
						title="Settings"
					>
						<Settings className="size-4" />
					</button>
					<ThemeToggle />
				</SidebarFooter>
			</SidebarRoot>

			{/* Archive task confirmation dialog */}
			<AlertDialog
				open={showTaskConfirmDialog}
				onOpenChange={(open) => !open && setArchiveTaskTarget(null)}
			>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Archive task "{archiveTaskName}"
						</AlertDialogTitle>
						<AlertDialogDescription>
							This task has uncommitted changes. Archiving will commit all
							changes with a "WIP" message before removing the worktree and
							deleting the task.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="outline" />}>
							Cancel
						</AlertDialogClose>
						<Button onClick={handleConfirmArchiveTask}>
							Commit and archive
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</SidebarProvider>
	);
}
