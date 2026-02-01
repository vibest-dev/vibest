import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@vibest/ui/components/button";
import { FolderGit2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Worktree } from "./types";

import { Header } from "./components/layout/header";
import { MainContent } from "./components/layout/main-content";
import { Sidebar } from "./components/layout/sidebar";
import { TerminalPanel } from "./components/terminal";
import { AddRepositoryDialog } from "./components/repositories/add-repository-dialog";
import { CloneRepositoryDialog } from "./components/repositories/clone-repository-dialog";
import { CreateWorktreeDialog } from "./components/worktrees/create-worktree-dialog";
import { WorktreeDiffView } from "./components/worktrees/worktree-diff-view";
import { client } from "./lib/client";
import { orpc } from "./lib/orpc";
import { queryClient } from "./lib/query-client";
import { useAppStore } from "./stores";

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
  const worktreesByRepository = useMemo(
    () => workspaceData?.worktreesByRepository ?? {},
    [workspaceData?.worktreesByRepository],
  );

  // UI state - Zustand (only selection and opened tracking)
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const selectWorktree = useAppStore((s) => s.selectWorktree);
  const openedWorktreeIds = useAppStore((s) => s.openedWorktreeIds);
  const markWorktreeOpened = useAppStore((s) => s.markWorktreeOpened);
  const removeWorktreeOpened = useAppStore((s) => s.removeWorktreeOpened);

  // Local UI state - expandedRepositories (not persisted, expands all on load)
  const [expandedRepositories, setExpandedRepositories] = useState<Set<string>>(new Set());

  // Local UI state (transient, not persisted)
  const [addRepositoryPath, setAddRepositoryPath] = useState<string | null>(null);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [showCreateWorktreeDialog, setShowCreateWorktreeDialog] = useState(false);
  const [createWorktreeRepositoryId, setCreateWorktreeRepositoryId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Mutations using oRPC TanStack Query utils with inline callbacks
  const addRepoMutation = useMutation({
    ...orpc.workspace.addRepository.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
    },
    onError: (error) => setMutationError(String(error)),
  });

  const cloneRepoMutation = useMutation({
    ...orpc.workspace.cloneRepository.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
    },
    onError: (error) => setMutationError(String(error)),
  });

  const removeRepoMutation = useMutation({
    ...orpc.workspace.removeRepository.mutationOptions(),
    onSuccess: (_: unknown, variables: { repositoryId: string }) => {
      // Clear selection if the selected worktree belongs to this repository
      const workspaceQueryData = queryClient.getQueryData(orpc.workspace.list.queryKey({}));
      if (workspaceQueryData) {
        const worktrees = workspaceQueryData.worktreesByRepository[variables.repositoryId];
        if (worktrees?.some((w) => w.id === selectedWorktreeId)) {
          selectWorktree(null);
        }
      }
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
    },
    onError: (error) => setMutationError(String(error)),
  });

  const createWorktreeMut = useMutation({
    ...orpc.workspace.createWorktree.mutationOptions(),
    onSuccess: (worktree) => {
      setExpandedRepositories((prev) => new Set([...prev, worktree.repositoryId]));
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
      queryClient.prefetchQuery(orpc.git.status.queryOptions({ input: { path: worktree.path } }));
    },
    onError: (error) => setMutationError(String(error)),
  });

  const quickCreateMutation = useMutation({
    ...orpc.workspace.quickCreateWorktree.mutationOptions(),
    onSuccess: (worktree) => {
      setExpandedRepositories((prev) => new Set([...prev, worktree.repositoryId]));
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
      queryClient.prefetchQuery(orpc.git.status.queryOptions({ input: { path: worktree.path } }));
    },
    onError: (error) => setMutationError(String(error)),
  });

  const archiveMutation = useMutation({
    ...orpc.workspace.archiveWorktree.mutationOptions(),
    onSuccess: (_: unknown, variables: { worktreeId: string; commitFirst?: boolean }) => {
      if (selectedWorktreeId === variables.worktreeId) {
        selectWorktree(null);
      }
      removeWorktreeOpened(variables.worktreeId);
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
    },
    onError: (error) => setMutationError(String(error)),
  });

  // Initialize expanded repositories - expand all on first load
  useEffect(() => {
    if (repositories.length > 0 && expandedRepositories.size === 0 && !isLoadingRepositories) {
      setExpandedRepositories(new Set(repositories.map((r) => r.id)));
    }
  }, [repositories, expandedRepositories.size, isLoadingRepositories]);

  // Mark worktree as opened when selected
  useEffect(() => {
    if (selectedWorktreeId) {
      markWorktreeOpened(selectedWorktreeId);
    }
  }, [selectedWorktreeId, markWorktreeOpened]);

  // Find the selected worktree from workspace data
  const selectedWorktree = useMemo(() => {
    if (!selectedWorktreeId) return null;
    for (const worktrees of Object.values(worktreesByRepository)) {
      const found = worktrees.find((w) => w.id === selectedWorktreeId);
      if (found) return found;
    }
    return null;
  }, [selectedWorktreeId, worktreesByRepository]);

  // Get all opened worktrees for terminal persistence
  const openedWorktrees = useMemo(() => {
    const allWorktrees = Object.values(worktreesByRepository).flat();
    return openedWorktreeIds
      .map((id) => allWorktrees.find((w) => w.id === id))
      .filter((w): w is Worktree => w !== undefined);
  }, [openedWorktreeIds, worktreesByRepository]);

  // Get selected repository from selected worktree
  const selectedRepository = selectedWorktree
    ? (repositories.find((r) => r.id === selectedWorktree.repositoryId) ?? null)
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
      setExpandedRepositories((prev) => {
        const next = new Set(prev);
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

  const handleCreateWorktreeFrom = useCallback((_repositoryId: string) => {
    // TODO: Implement create workspace from repository
  }, []);

  const handleRefresh = () => {
    // TanStack Query will handle refetching
    // This is handled by invalidating queries, but we can also force refetch
  };

  const clearError = () => setMutationError(null);

  return (
    <div className="bg-background text-foreground flex h-screen overflow-hidden">
      <div className="h-full shrink-0">
        <Sidebar
          repositories={repositories}
          worktreesByRepository={worktreesByRepository}
          selectedWorktreeId={selectedWorktreeId}
          expandedRepositories={expandedRepositories}
          isLoading={isLoadingRepositories}
          onAddRepository={handleAddRepository}
          onCloneRepository={() => setShowCloneDialog(true)}
          onCreateWorktree={handleCreateWorktree}
          onCreateWorktreeFrom={handleCreateWorktreeFrom}
          onToggleRepository={handleToggleRepository}
          onViewChanges={(worktree) => selectWorktree(worktree?.id ?? null)}
          onArchiveWorktree={(worktreeId, commitFirst) =>
            archiveMutation.mutate({ worktreeId, commitFirst })
          }
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          repository={selectedRepository ?? null}
          onRemoveRepository={(repositoryId) => removeRepoMutation.mutate({ repositoryId })}
          onRefresh={handleRefresh}
        />

        <MainContent fullBleed={openedWorktrees.length > 0}>
          {selectedWorktree ? (
            <div className="flex h-full">
              {/* Terminal (left side) */}
              <div className="relative min-w-0 flex-1">
                {openedWorktrees.map((worktree) => (
                  <TerminalPanel
                    key={worktree.id}
                    worktreeId={worktree.id}
                    worktreePath={worktree.path}
                    worktreeExists={worktree.exists}
                    isVisible={worktree.id === selectedWorktreeId}
                  />
                ))}
              </div>
              {/* Diff View (right side) */}
              <div className="border-border h-full w-1/2 shrink-0 border-l">
                <WorktreeDiffView worktree={selectedWorktree} onClose={() => selectWorktree(null)} />
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center">
              <div className="bg-muted mb-5 flex h-14 w-14 items-center justify-center rounded-2xl">
                <FolderGit2 className="text-muted-foreground h-7 w-7" />
              </div>
              <h2 className="text-foreground mb-1 text-[15px] font-semibold">
                No Worktree Selected
              </h2>
              <p className="text-muted-foreground max-w-xs text-center text-[13px]">
                Select a worktree from the sidebar to open terminals
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
// test
