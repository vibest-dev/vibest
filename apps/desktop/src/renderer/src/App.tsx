import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@vibest/ui/components/button";
import { FolderGit2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Worktree } from "./types";

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

function App(): React.JSX.Element {
  // Server state - TanStack Query via oRPC
  const {
    data: workspaceData,
    isLoading: isLoadingRepositories,
    error: queryError,
  } = useQuery(orpc.workspace.list.queryOptions({}));

  const repositories = useMemo(
    () => workspaceData?.repositories ?? [],
    [workspaceData?.repositories],
  );
  const worktreesByRepository = workspaceData?.worktreesByRepository ?? {};

  // UI state - Zustand
  const expandedRepositories = useUIStore((s) => s.expandedRepositories);
  const toggleRepository = useUIStore((s) => s.toggleRepository);
  const expandRepository = useUIStore((s) => s.expandRepository);
  const setExpandedRepositories = useUIStore((s) => s.setExpandedRepositories);

  // Local UI state (transient, not persisted)
  const [addRepositoryPath, setAddRepositoryPath] = useState<string | null>(null);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [showCreateWorktreeDialog, setShowCreateWorktreeDialog] = useState(false);
  const [createWorktreeRepositoryId, setCreateWorktreeRepositoryId] = useState<string | null>(null);
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
    if (repositories.length > 0 && expandedRepositories.length === 0 && !isLoadingRepositories) {
      setExpandedRepositories(repositories.map((r) => r.id));
    }
  }, [repositories, expandedRepositories.length, isLoadingRepositories, setExpandedRepositories]);

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
    <div className="bg-background text-foreground flex h-screen">
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

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          repository={selectedRepository ?? null}
          onRemoveRepository={(repositoryId) => removeRepoMutation.mutate({ repositoryId })}
          onRefresh={handleRefresh}
        />

        <MainContent>
          {diffWorktree ? (
            <DiffViewer worktree={diffWorktree} onClose={() => setDiffWorktree(null)} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center">
              <div className="bg-muted mb-5 flex h-14 w-14 items-center justify-center rounded-2xl">
                <FolderGit2 className="text-muted-foreground h-7 w-7" />
              </div>
              <h2 className="text-foreground mb-1 text-[15px] font-semibold">
                No Worktree Selected
              </h2>
              <p className="text-muted-foreground max-w-xs text-center text-[13px]">
                Select a worktree from the sidebar to view changes
              </p>
            </div>
          )}
        </MainContent>
      </div>

      {/* Error toast */}
      {error && (
        <div className="bg-destructive/10 border-destructive/20 text-destructive-foreground animate-in slide-in-from-bottom-2 fixed right-4 bottom-4 flex max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-lg">
          <p className="flex-1 pt-0.5 text-[13px]">{error}</p>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-destructive-foreground/70 hover:text-destructive-foreground hover:bg-destructive/10 h-6 w-6 shrink-0"
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
            ? (repositories.find((r) => r.id === createWorktreeRepositoryId) ?? null)
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
