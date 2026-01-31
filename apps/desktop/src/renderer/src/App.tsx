import { useMutation, useQuery } from "@tanstack/react-query";
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
import {
	addRepositoryMutationCallbacks,
	archiveWorktreeMutationCallbacks,
	cloneRepositoryMutationCallbacks,
	createWorktreeMutationCallbacks,
	orpc,
	quickCreateWorktreeMutationCallbacks,
	removeRepositoryMutationCallbacks,
} from "./lib/queries/workspace";
import { useUIStore } from "./stores/ui-store";
import type { Worktree } from "./types";

function App(): React.JSX.Element {
	// Server state - TanStack Query via oRPC
	const {
		data: workspaceData,
		isLoading: isLoadingRepositories,
		error: queryError,
	} = useQuery(orpc.workspace.list.queryOptions({}));

	const repositories = workspaceData?.repositories ?? [];
	const worktreesByRepository = workspaceData?.worktreesByRepository ?? {};

	// UI state - Zustand
	const expandedRepositories = useUIStore((s) => s.expandedRepositories);
	const toggleRepository = useUIStore((s) => s.toggleRepository);
	const expandRepository = useUIStore((s) => s.expandRepository);
	const setExpandedRepositories = useUIStore((s) => s.setExpandedRepositories);

	// Local UI state (transient, not persisted)
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
	const [mutationError, setMutationError] = useState<string | null>(null);

	// Mutations using oRPC TanStack Query utils
	const addRepoMutation = useMutation({
		...orpc.workspace.addRepository.mutationOptions(),
		...addRepositoryMutationCallbacks(),
		onError: (error) => setMutationError(String(error)),
	});

	const cloneRepoMutation = useMutation({
		...orpc.workspace.cloneRepository.mutationOptions(),
		...cloneRepositoryMutationCallbacks(),
		onError: (error) => setMutationError(String(error)),
	});

	const removeRepoMutation = useMutation({
		...orpc.workspace.removeRepository.mutationOptions(),
		...removeRepositoryMutationCallbacks(),
		onError: (error) => setMutationError(String(error)),
	});

	const createWorktreeMut = useMutation({
		...orpc.workspace.createWorktree.mutationOptions(),
		...createWorktreeMutationCallbacks(),
		onError: (error) => setMutationError(String(error)),
	});

	const quickCreateMutation = useMutation({
		...orpc.workspace.quickCreateWorktree.mutationOptions(),
		...quickCreateWorktreeMutationCallbacks(),
		onError: (error) => setMutationError(String(error)),
	});

	const archiveMutation = useMutation({
		...orpc.workspace.archiveWorktree.mutationOptions(),
		...archiveWorktreeMutationCallbacks(),
		onError: (error) => setMutationError(String(error)),
	});

	// Initialize expanded repositories - expand all on first load if none are expanded
	useEffect(() => {
		if (
			repositories.length > 0 &&
			expandedRepositories.length === 0 &&
			!isLoadingRepositories
		) {
			setExpandedRepositories(repositories.map((r) => r.id));
		}
	}, [
		repositories,
		expandedRepositories.length,
		isLoadingRepositories,
		setExpandedRepositories,
	]);

	// Get selected repository from diff worktree
	const selectedRepository = diffWorktree
		? (repositories.find((r) => r.id === diffWorktree.repositoryId) ?? null)
		: null;

	const error = queryError ? String(queryError) : mutationError;

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
		await quickCreateMutation.mutateAsync({ repositoryId });
	};

	const handleToggleRepository = useCallback(
		(repositoryId: string, open: boolean) => {
			if (open) {
				expandRepository(repositoryId);
			} else {
				toggleRepository(repositoryId);
			}
		},
		[expandRepository, toggleRepository],
	);

	const handleCreateWorktreeFrom = useCallback((repositoryId: string) => {
		// TODO: Implement create workspace from repository
		console.log("Create workspace from repository:", repositoryId);
	}, []);

	const handleRefresh = () => {
		// TanStack Query will handle refetching
		// This is handled by invalidating queries, but we can also force refetch
	};

	const clearError = () => setMutationError(null);

	return (
		<div className="flex h-screen bg-background text-foreground">
			<Sidebar
				repositories={repositories}
				worktreesByRepository={worktreesByRepository}
				selectedWorktreeId={diffWorktree?.id ?? null}
				expandedRepositories={new Set(expandedRepositories)}
				isLoading={isLoadingRepositories}
				onAddRepository={handleAddRepository}
				onCloneRepository={() => setShowCloneDialog(true)}
				onCreateWorktree={handleCreateWorktree}
				onCreateWorktreeFrom={handleCreateWorktreeFrom}
				onToggleRepository={handleToggleRepository}
				onViewChanges={setDiffWorktree}
				onArchiveWorktree={(worktreeId, commitFirst) =>
					archiveMutation.mutate({ worktreeId, commitFirst })
				}
			/>

			<div className="flex-1 flex flex-col min-w-0">
				<Header
					repository={selectedRepository ?? null}
					onRemoveRepository={(repositoryId) =>
						removeRepoMutation.mutate({ repositoryId })
					}
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
				onAdd={async (path, defaultBranch) => {
					await addRepoMutation.mutateAsync({ path, defaultBranch });
				}}
			/>

			<CloneRepositoryDialog
				isOpen={showCloneDialog}
				onClose={() => setShowCloneDialog(false)}
				onClone={async (url, targetPath) => {
					await cloneRepoMutation.mutateAsync({ url, targetPath });
				}}
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
				onCreate={async (params) => {
					await createWorktreeMut.mutateAsync(params);
				}}
			/>
		</div>
	);
}

export default App;
