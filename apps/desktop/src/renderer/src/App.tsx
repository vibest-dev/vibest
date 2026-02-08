import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@vibest/ui/components/button";
import { FolderGit2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Task, Worktree } from "./types";

import { LabelManagerDialog } from "./components/label";
import { Header } from "./components/layout/header";
import { MainContent } from "./components/layout/main-content";
import { Sidebar } from "./components/layout/sidebar";
import { AddRepositoryDialog } from "./components/repositories/add-repository-dialog";
import { CloneRepositoryDialog } from "./components/repositories/clone-repository-dialog";
import { CreateTaskDialog, EditTaskDialog } from "./components/task";
import { TerminalPanel } from "./components/terminal";
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

  // UI state - Zustand (task selection and worktree tracking)
  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const setCurrentTask = useAppStore((s) => s.setCurrentTask);
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const selectWorktree = useAppStore((s) => s.selectWorktree);
  const worktreeTerminalIds = useAppStore((s) => s.worktreeTerminalIds);
  const addWorktreeTerminal = useAppStore((s) => s.addWorktreeTerminal);
  const removeWorktreeTerminal = useAppStore((s) => s.removeWorktreeTerminal);
  const clearActiveTerminalId = useAppStore((s) => s.clearActiveTerminalId);

  // Local UI state (transient, not persisted)
  const [addRepositoryPath, setAddRepositoryPath] = useState<string | null>(null);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [showCreateTaskDialog, setShowCreateTaskDialog] = useState(false);
  const [createTaskRepositoryId, setCreateTaskRepositoryId] = useState<string | null>(null);
  const [showLabelManagerDialog, setShowLabelManagerDialog] = useState(false);
  const [labelManagerRepositoryId, setLabelManagerRepositoryId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [showEditTaskDialog, setShowEditTaskDialog] = useState(false);
  const [editTaskTarget, setEditTaskTarget] = useState<Task | null>(null);

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

  const archiveTaskMutation = useMutation({
    ...orpc.task.delete.mutationOptions(),
    onSuccess: (
      _,
      variables: { taskId: string; deleteWorktree?: boolean; commitFirst?: boolean },
    ) => {
      // Get worktrees for the archived task BEFORE updating cache
      const workspaceQueryData = queryClient.getQueryData(orpc.workspace.list.queryKey({}));
      const archivedTaskWorktrees = Object.values(
        workspaceQueryData?.worktreesByRepository ?? {},
      )
        .flat()
        .filter((w) => w.taskId === variables.taskId);

      // Clear selection if archived task is selected
      if (currentTaskId === variables.taskId) {
        setCurrentTask(null);
        selectWorktree(null);
      }

      // Remove all worktrees belonging to the archived task from opened worktrees
      archivedTaskWorktrees.forEach((worktree) => {
        removeWorktreeTerminal(worktree.id);
        clearActiveTerminalId(worktree.id);
      });

      // Use optimistic update instead of invalidating workspace query
      // This avoids triggering a refetch which would cause terminal rerenders
      if (workspaceQueryData) {
        const updatedWorktreesByRepository = { ...workspaceQueryData.worktreesByRepository };
        
        // Remove worktrees of the archived task from each repository
        for (const [repoId, worktrees] of Object.entries(updatedWorktreesByRepository)) {
          updatedWorktreesByRepository[repoId] = worktrees.filter(
            (w) => w.taskId !== variables.taskId,
          );
        }

        queryClient.setQueryData(orpc.workspace.list.queryKey({}), {
          ...workspaceQueryData,
          worktreesByRepository: updatedWorktreesByRepository,
        });
      }

      // Only invalidate task queries, not workspace
      queryClient.invalidateQueries({ queryKey: orpc.task.key() });
    },
    onError: (error) => setMutationError(String(error)),
  });

  // Mark worktree as opened when selected
  useEffect(() => {
    if (selectedWorktreeId) {
      addWorktreeTerminal(selectedWorktreeId);
    }
  }, [selectedWorktreeId, addWorktreeTerminal]);

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
    return worktreeTerminalIds
      .map((id) => allWorktrees.find((w) => w.id === id))
      .filter((w): w is Worktree => w !== undefined);
  }, [worktreeTerminalIds, worktreesByRepository]);

  // Fetch selected task data
  const { data: selectedTaskData } = useQuery(
    orpc.task.get.queryOptions({
      input: currentTaskId ? { taskId: currentTaskId } : skipToken,
    }),
  );

  const selectedTask = selectedTaskData?.task ?? null;
  const selectedTaskWorktree = selectedTaskData?.worktrees[0] ?? null;

  // Get selected repository from selected task or worktree
  const selectedRepository = useMemo(() => {
    if (selectedTask) {
      return repositories.find((r) => r.id === selectedTask.repositoryId) ?? null;
    }
    if (selectedWorktree) {
      return repositories.find((r) => r.id === selectedWorktree.repositoryId) ?? null;
    }
    return null;
  }, [selectedTask, selectedWorktree, repositories]);

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

  const handleCreateTask = (repositoryId: string) => {
    setCreateTaskRepositoryId(repositoryId);
    setShowCreateTaskDialog(true);
  };

  const handleManageLabels = (repositoryId: string) => {
    setLabelManagerRepositoryId(repositoryId);
    setShowLabelManagerDialog(true);
  };

  const handleEditTask = useCallback((task: Task) => {
    setEditTaskTarget(task);
    setShowEditTaskDialog(true);
  }, []);

  const handleHeaderArchiveTask = useCallback(
    (taskId: string) => {
      // For header archive, we need to check git status first
      // For simplicity, just archive without commit - can be enhanced later
      archiveTaskMutation.mutate({ taskId, deleteWorktree: true, commitFirst: false });
    },
    [archiveTaskMutation],
  );

  const handleSelectTask = useCallback(
    (task: Task, worktree: Worktree | null) => {
      setCurrentTask(task.id);
      if (worktree) {
        selectWorktree(worktree.id);
        addWorktreeTerminal(worktree.id);
      } else {
        selectWorktree(null);
      }
    },
    [setCurrentTask, selectWorktree, addWorktreeTerminal],
  );

  const handleArchiveTask = useCallback(
    (taskId: string, commitFirst: boolean) => {
      archiveTaskMutation.mutate({ taskId, deleteWorktree: true, commitFirst });
    },
    [archiveTaskMutation],
  );

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
          currentTaskId={currentTaskId}
          isLoading={isLoadingRepositories}
          onAddRepository={handleAddRepository}
          onCloneRepository={() => setShowCloneDialog(true)}
          onCreateTask={handleCreateTask}
          onSelectTask={handleSelectTask}
          onArchiveTask={handleArchiveTask}
          onManageLabels={handleManageLabels}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          repository={selectedRepository}
          task={selectedTask}
          worktree={selectedTaskWorktree}
          onRemoveRepository={(repositoryId) => removeRepoMutation.mutate({ repositoryId })}
          onEditTask={handleEditTask}
          onArchiveTask={handleHeaderArchiveTask}
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
                <WorktreeDiffView
                  worktree={selectedWorktree}
                  onClose={() => selectWorktree(null)}
                />
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center">
              <div className="bg-muted mb-5 flex h-14 w-14 items-center justify-center rounded-2xl">
                <FolderGit2 className="text-muted-foreground h-7 w-7" />
              </div>
              <h2 className="text-foreground mb-1 text-[15px] font-semibold">No Task Selected</h2>
              <p className="text-muted-foreground max-w-xs text-center text-[13px]">
                Select a task from the sidebar to open a terminal
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

      <CreateTaskDialog
        isOpen={showCreateTaskDialog}
        repository={
          createTaskRepositoryId
            ? (repositories.find((r) => r.id === createTaskRepositoryId) ?? null)
            : null
        }
        onClose={() => {
          setShowCreateTaskDialog(false);
          setCreateTaskRepositoryId(null);
        }}
      />

      <EditTaskDialog
        isOpen={showEditTaskDialog}
        task={editTaskTarget}
        repository={
          editTaskTarget
            ? (repositories.find((r) => r.id === editTaskTarget.repositoryId) ?? null)
            : null
        }
        onClose={() => {
          setShowEditTaskDialog(false);
          setEditTaskTarget(null);
        }}
      />

      <LabelManagerDialog
        isOpen={showLabelManagerDialog}
        repository={
          labelManagerRepositoryId
            ? (repositories.find((r) => r.id === labelManagerRepositoryId) ?? null)
            : null
        }
        onClose={() => {
          setShowLabelManagerDialog(false);
          setLabelManagerRepositoryId(null);
        }}
      />
    </div>
  );
}

export default App;
