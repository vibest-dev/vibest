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
	const repositories = useWorkspaceStore((s) => s.repositories);
	const worktreesByRepository = useWorkspaceStore(
		(s) => s.worktreesByRepository,
	);
	const isLoadingRepositories = useWorkspaceStore(
		(s) => s.isLoadingRepositories,
	);
	const error = useWorkspaceStore((s) => s.error);

	const loadRepositories = useWorkspaceStore((s) => s.loadRepositories);
	const addRepository = useWorkspaceStore((s) => s.addRepository);
	const cloneRepository = useWorkspaceStore((s) => s.cloneRepository);
	const removeRepository = useWorkspaceStore((s) => s.removeRepository);
	const createWorktree = useWorkspaceStore((s) => s.createWorktree);
	const quickCreateWorktree = useWorkspaceStore((s) => s.quickCreateWorktree);
	const clearError = useWorkspaceStore((s) => s.clearError);

	const [addRepositoryPath, setAddRepositoryPath] = useState<string | null>(
		null,
	);
	const [showCloneDialog, setShowCloneDialog] = useState(false);
	const [showCreateWorktreeDialog, setShowCreateWorktreeDialog] =
		useState(false);
	const [createWorktreeRepositoryId, setCreateWorktreeRepositoryId] = useState<
		string | null
	>(null);
	const [diffWorktree, setDiffWorktree] = useState<Worktree | null>(null);
	const [expandedRepositories, setExpandedRepositories] =
		useState<Set<string> | null>(null);

	// Load repositories on mount
	useEffect(() => {
		loadRepositories();
	}, [loadRepositories]);

	// Initialize expanded repositories - expand all repositories by default
	useEffect(() => {
		if (repositories.length > 0 && expandedRepositories === null) {
			setExpandedRepositories(new Set(repositories.map((r) => r.id)));
		}
	}, [repositories, expandedRepositories]);

	// Get selected repository from diff worktree
	const selectedRepository = diffWorktree
		? (repositories.find((r) => r.id === diffWorktree.repositoryId) ?? null)
		: null;

	const handleAddRepository = async () => {
		try {
			const selectedPath = await client.fs.selectDir();
			if (selectedPath) {
				setAddRepositoryPath(selectedPath);
			}
		} catch (err) {
			console.error("Failed to select directory:", err);
		}
	};

	const handleCreateWorktree = async (repositoryId: string) => {
		// Quick create worktree directly without dialog
		await quickCreateWorktree(repositoryId);
		// Expand the repository after creating worktree
		setExpandedRepositories((prev) => new Set(prev ?? []).add(repositoryId));
	};

	const handleToggleRepository = useCallback(
		(repositoryId: string, open: boolean) => {
			setExpandedRepositories((prev) => {
				const next = new Set(prev ?? []);
				if (open) {
					next.add(repositoryId);
				} else {
					next.delete(repositoryId);
				}
				return next;
			});
		},
		[],
	);

	const handleCreateWorktreeFrom = useCallback(
		(repositoryId: string) => {
			// TODO: Implement create workspace from repository
			console.log("Create workspace from repository:", repositoryId);
		},
		[],
	);

	const handleRefresh = () => {
		loadRepositories();
	};

	return (
		<div className="flex h-screen bg-background text-foreground">
			<Sidebar
				repositories={repositories}
				worktreesByRepository={worktreesByRepository}
				selectedWorktreeId={diffWorktree?.id ?? null}
				expandedRepositories={
					expandedRepositories ?? new Set(repositories.map((r) => r.id))
				}
				isLoading={isLoadingRepositories}
				onAddRepository={handleAddRepository}
				onCloneRepository={() => setShowCloneDialog(true)}
				onCreateWorktree={handleCreateWorktree}
				onCreateWorktreeFrom={handleCreateWorktreeFrom}
				onToggleRepository={handleToggleRepository}
				onViewChanges={setDiffWorktree}
			/>

			<div className="flex-1 flex flex-col min-w-0">
				<Header
					repository={selectedRepository ?? null}
					onRemoveRepository={removeRepository}
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
				isOpen={addRepositoryPath !== null}
				path={addRepositoryPath}
				onClose={() => setAddRepositoryPath(null)}
				onAdd={addRepository}
			/>

			<CloneRepositoryDialog
				isOpen={showCloneDialog}
				onClose={() => setShowCloneDialog(false)}
				onClone={cloneRepository}
			/>

			<CreateWorktreeDialog
				isOpen={showCreateWorktreeDialog}
				repository={
					createWorktreeRepositoryId
						? (repositories.find((r) => r.id === createWorktreeRepositoryId) ??
							null)
						: null
				}
				onClose={() => {
					setShowCreateWorktreeDialog(false);
					setCreateWorktreeRepositoryId(null);
				}}
				onCreate={createWorktree}
			/>
		</div>
	);
}

export default App;
