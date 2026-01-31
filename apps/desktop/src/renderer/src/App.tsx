import { Button } from "@vibest/ui/components/button";
import { FolderGit2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Header } from "./components/layout/header";
import { MainContent } from "./components/layout/main-content";
import { Sidebar } from "./components/layout/sidebar";
import { AddRepositoryDialog } from "./components/repositories/add-repository-dialog";
import { CloneRepositoryDialog } from "./components/repositories/clone-repository-dialog";
import { CreateWorktreeDialog } from "./components/worktrees/create-worktree-dialog";
import { DiffViewer } from "./components/worktrees/diff-viewer";
import { client } from "./lib/client";
import { useWorkspaceStore } from "./stores";
import type { Worktree } from "./types";

function App(): React.JSX.Element {
	const repos = useWorkspaceStore((s) => s.repos);
	const worktreesByRepo = useWorkspaceStore((s) => s.worktreesByRepo);
	const isLoadingRepos = useWorkspaceStore((s) => s.isLoadingRepos);
	const error = useWorkspaceStore((s) => s.error);

	const loadRepos = useWorkspaceStore((s) => s.loadRepos);
	const addRepo = useWorkspaceStore((s) => s.addRepo);
	const cloneRepo = useWorkspaceStore((s) => s.cloneRepo);
	const removeRepo = useWorkspaceStore((s) => s.removeRepo);
	const createWorktree = useWorkspaceStore((s) => s.createWorktree);
	const quickCreateWorktree = useWorkspaceStore((s) => s.quickCreateWorktree);
	const clearError = useWorkspaceStore((s) => s.clearError);

	const [addRepoPath, setAddRepoPath] = useState<string | null>(null);
	const [showCloneDialog, setShowCloneDialog] = useState(false);
	const [showCreateWorktreeDialog, setShowCreateWorktreeDialog] =
		useState(false);
	const [createWorktreeRepoId, setCreateWorktreeRepoId] = useState<
		string | null
	>(null);
	const [diffWorktree, setDiffWorktree] = useState<Worktree | null>(null);
	const [expandedRepos, setExpandedRepos] = useState<Set<string> | null>(null);

	// Load repositories on mount
	useEffect(() => {
		loadRepos();
	}, [loadRepos]);

	// Initialize expanded repos - expand all repos by default
	useEffect(() => {
		if (repos.length > 0 && expandedRepos === null) {
			setExpandedRepos(new Set(repos.map((r) => r.id)));
		}
	}, [repos, expandedRepos]);

	// Get selected repo from diff worktree
	const selectedRepo = diffWorktree
		? (repos.find((r) => r.id === diffWorktree.repositoryId) ?? null)
		: null;

	const handleAddRepo = async () => {
		try {
			const selectedPath = await client.fs.selectDir();
			if (selectedPath) {
				setAddRepoPath(selectedPath);
			}
		} catch (err) {
			console.error("Failed to select directory:", err);
		}
	};

	const handleCreateWorktree = async (repositoryId: string) => {
		// Quick create worktree directly without dialog
		await quickCreateWorktree(repositoryId);
		// Expand the repo after creating worktree
		setExpandedRepos((prev) => new Set(prev ?? []).add(repositoryId));
	};

	const handleToggleRepo = useCallback((repoId: string, open: boolean) => {
		setExpandedRepos((prev) => {
			const next = new Set(prev ?? []);
			if (open) {
				next.add(repoId);
			} else {
				next.delete(repoId);
			}
			return next;
		});
	}, []);

	const handleRefresh = () => {
		loadRepos();
	};

	return (
		<div className="flex h-screen bg-background text-foreground">
			<Sidebar
				repositories={repos}
				worktreesByRepo={worktreesByRepo}
				selectedWorktreeId={diffWorktree?.id ?? null}
				expandedRepos={expandedRepos ?? new Set(repos.map((r) => r.id))}
				isLoading={isLoadingRepos}
				onAddRepo={handleAddRepo}
				onCloneRepo={() => setShowCloneDialog(true)}
				onCreateWorktree={handleCreateWorktree}
				onToggleRepo={handleToggleRepo}
				onViewChanges={setDiffWorktree}
			/>

			<div className="flex-1 flex flex-col min-w-0">
				<Header
					repo={selectedRepo ?? null}
					onRemoveRepo={removeRepo}
					onRefresh={handleRefresh}
				/>

				<MainContent>
					{diffWorktree ? (
						<DiffViewer
							worktree={diffWorktree}
							onClose={() => setDiffWorktree(null)}
						/>
					) : (
						<div className="flex flex-col items-center justify-center h-full">
							<div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-muted mb-5">
								<FolderGit2 className="w-7 h-7 text-muted-foreground" />
							</div>
							<h2 className="text-[15px] font-semibold text-foreground mb-1">
								No Worktree Selected
							</h2>
							<p className="text-[13px] text-muted-foreground text-center max-w-xs">
								Select a worktree from the sidebar to view changes
							</p>
						</div>
					)}
				</MainContent>
			</div>

			{/* Error toast */}
			{error && (
				<div className="fixed bottom-4 right-4 max-w-sm bg-destructive/10 border border-destructive/20 text-destructive-foreground px-4 py-3 rounded-xl shadow-lg flex items-start gap-3 animate-in slide-in-from-bottom-2">
					<p className="text-[13px] flex-1 pt-0.5">{error}</p>
					<Button
						variant="ghost"
						size="icon-xs"
						className="shrink-0 h-6 w-6 text-destructive-foreground/70 hover:text-destructive-foreground hover:bg-destructive/10"
						onClick={clearError}
						aria-label="Dismiss error"
					>
						<X className="h-3.5 w-3.5" />
					</Button>
				</div>
			)}

			<AddRepositoryDialog
				isOpen={addRepoPath !== null}
				path={addRepoPath}
				onClose={() => setAddRepoPath(null)}
				onAdd={addRepo}
			/>

			<CloneRepositoryDialog
				isOpen={showCloneDialog}
				onClose={() => setShowCloneDialog(false)}
				onClone={cloneRepo}
			/>

			<CreateWorktreeDialog
				isOpen={showCreateWorktreeDialog}
				repo={
					createWorktreeRepoId
						? (repos.find((r) => r.id === createWorktreeRepoId) ?? null)
						: null
				}
				onClose={() => {
					setShowCreateWorktreeDialog(false);
					setCreateWorktreeRepoId(null);
				}}
				onCreate={createWorktree}
			/>
		</div>
	);
}

export default App;
