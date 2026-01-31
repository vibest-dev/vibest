import { Button } from "@vibest/ui/components/button";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuTrigger,
} from "@vibest/ui/components/menu";
import {
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
import { useGitStatus } from "../../hooks/use-git-status";
import { client } from "../../lib/client";
import { cn } from "../../lib/utils";
import type { Worktree } from "../../types";
import { WorktreeStatus } from "./worktree-status";

interface WorktreeCardProps {
	worktree: Worktree;
	onOpen: (id: string) => void;
	onRemove: (id: string) => void;
	onViewChanges: (id: string) => void;
}

export function WorktreeCard({
	worktree,
	onOpen,
	onRemove,
	onViewChanges,
}: WorktreeCardProps) {
	const { status, isLoading, fetch, pull } = useGitStatus(worktree.path);
	const [isFetching, setIsFetching] = useState(false);
	const [isPulling, setIsPulling] = useState(false);

	const placeName = worktree.path.split("/").pop() || worktree.branch;
	const shortPath = worktree.path.replace(/^\/Users\/[^/]+/, "~");

	const handleFetch = async () => {
		setIsFetching(true);
		await fetch();
		setIsFetching(false);
	};

	const handlePull = async () => {
		setIsPulling(true);
		await pull();
		setIsPulling(false);
	};

	const handleOpenFinder = () => {
		client.fs.openFinder({ path: worktree.path });
	};

	const handleOpenTerminal = () => {
		client.fs.openTerminal({ path: worktree.path });
	};

	return (
		<article
			className={cn(
				"group relative rounded-xl border bg-card p-4 transition-all duration-200",
				"hover:shadow-md hover:border-border/80 border-border",
			)}
		>
			{/* Header */}
			<div className="flex items-start justify-between mb-3">
				<div className="flex items-start gap-3 min-w-0">
					<div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-muted">
						<GitBranch className="w-4 h-4 text-muted-foreground" />
					</div>
					<div className="min-w-0 pt-0.5">
						<div className="flex items-center gap-2">
							<span className="text-[13px] font-semibold text-foreground truncate">
								{placeName}
							</span>
						</div>
						<p className="text-[11px] text-muted-foreground truncate mt-0.5">
							{worktree.branch}
						</p>
					</div>
				</div>

				<Menu>
					<MenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon-xs"
								className="h-6 w-6 opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground hover:text-foreground"
								aria-label="Worktree options"
							>
								<MoreVertical className="h-3.5 w-3.5" />
							</Button>
						}
					/>
					<MenuPopup side="bottom" align="end">
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
						<MenuItem
							variant="destructive"
							onClick={() => onRemove(worktree.id)}
						>
							<Trash2 className="h-4 w-4" />
							Delete Worktree
						</MenuItem>
					</MenuPopup>
				</Menu>
			</div>

			{/* Path */}
			<p
				className="text-[11px] text-muted-foreground/70 truncate mb-3 font-mono"
				title={worktree.path}
			>
				{shortPath}
			</p>

			{/* Status */}
			<div className="mb-4">
				<WorktreeStatus status={status} isLoading={isLoading} />
			</div>

			{/* Actions */}
			<div className="flex items-center gap-1.5">
				<Button
					variant="secondary"
					size="sm"
					className="flex-1 h-8 text-[12px] font-medium"
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
					className="h-8 w-8 text-muted-foreground hover:text-foreground"
					onClick={handleFetch}
					disabled={isFetching}
					aria-label="Fetch"
				>
					<RefreshCw
						className={cn("h-3.5 w-3.5", isFetching && "animate-spin")}
					/>
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					className="h-8 w-8 text-muted-foreground hover:text-foreground"
					onClick={handlePull}
					disabled={isPulling}
					aria-label="Pull"
				>
					<ArrowDownToLine
						className={cn("h-3.5 w-3.5", isPulling && "animate-bounce")}
					/>
				</Button>
			</div>
		</article>
	);
}
