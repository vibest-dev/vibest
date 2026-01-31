import { Button } from "@vibest/ui/components/button";
import { Skeleton } from "@vibest/ui/components/skeleton";
import { GitBranch, Plus } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { Worktree } from "../../types";
import { WorktreeCard } from "./worktree-card";

// Lazy load the diff viewer dialog to avoid loading @pierre/diffs on initial render
const DiffViewerDialog = lazy(() =>
	import("./diff-viewer-dialog").then((mod) => ({
		default: mod.DiffViewerDialog,
	})),
);

interface WorktreeListProps {
	worktrees: Worktree[];
	isLoading: boolean;
	onOpen: (id: string) => void;
	onRemove: (id: string) => void;
	onCreateNew: () => void;
}

export function WorktreeList({
	worktrees,
	isLoading,
	onOpen,
	onRemove,
	onCreateNew,
}: WorktreeListProps) {
	const [diffWorktree, setDiffWorktree] = useState<Worktree | null>(null);

	const handleViewChanges = (id: string) => {
		const worktree = worktrees.find((w) => w.id === id);
		if (worktree) {
			setDiffWorktree(worktree);
		}
	};

	if (isLoading) {
		return (
			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<h2 className="text-[15px] font-semibold text-foreground">
							Worktrees
						</h2>
						<Skeleton className="h-5 w-6 rounded-full" />
					</div>
					<Skeleton className="h-8 w-28 rounded-md" />
				</div>
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{[1, 2, 3].map((i) => (
						<div
							key={i}
							className="rounded-xl border border-border bg-card p-4"
						>
							<div className="flex items-start gap-3 mb-3">
								<Skeleton className="h-8 w-8 rounded-lg" />
								<div className="flex-1 space-y-2">
									<Skeleton className="h-4 w-24" />
									<Skeleton className="h-3 w-16" />
								</div>
							</div>
							<Skeleton className="h-3 w-40 mb-4" />
							<div className="flex gap-2">
								<Skeleton className="h-8 flex-1 rounded-md" />
								<Skeleton className="h-8 w-8 rounded-md" />
							</div>
						</div>
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2.5">
					<h2 className="text-[15px] font-semibold text-foreground">
						Worktrees
					</h2>
					<span className="text-[11px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full tabular-nums">
						{worktrees.length}
					</span>
				</div>
				<Button size="sm" onClick={onCreateNew} className="h-8 text-[13px]">
					<Plus className="h-3.5 w-3.5" />
					New Worktree
				</Button>
			</div>

			{worktrees.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 rounded-xl border border-dashed border-border bg-card/50">
					<div className="flex items-center justify-center w-12 h-12 rounded-xl bg-muted mb-4">
						<GitBranch className="w-6 h-6 text-muted-foreground" />
					</div>
					<p className="text-[14px] font-medium text-foreground mb-1">
						No worktrees yet
					</p>
					<p className="text-[13px] text-muted-foreground mb-4">
						Create one to work on multiple branches simultaneously
					</p>
					<Button size="sm" variant="secondary" onClick={onCreateNew}>
						<Plus className="h-3.5 w-3.5" />
						Create Worktree
					</Button>
				</div>
			) : (
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{worktrees.map((worktree) => (
						<WorktreeCard
							key={worktree.id}
							worktree={worktree}
							onOpen={onOpen}
							onRemove={onRemove}
							onViewChanges={handleViewChanges}
						/>
					))}
				</div>
			)}

			{/* Diff Viewer Dialog */}
			{diffWorktree && (
				<Suspense fallback={null}>
					<DiffViewerDialog
						isOpen={diffWorktree !== null}
						worktree={diffWorktree}
						onClose={() => setDiffWorktree(null)}
					/>
				</Suspense>
			)}
		</div>
	);
}
