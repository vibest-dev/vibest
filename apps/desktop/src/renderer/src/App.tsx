import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@vibest/ui/components/button";
import {
  Splitter,
  SplitterPanel,
  SplitterResizeTrigger,
  SplitterResizeTriggerIndicator,
} from "@vibest/ui/components/splitter";
import { FolderGit2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { DiffFileInfo, Task, Worktree } from "./types";

import { LabelManagerDialog } from "./components/label";
import { PrimarySidebarOverlay } from "./components/layout/primary-sidebar-overlay";
import { SecondarySidebar } from "./components/layout/secondary-sidebar";
import { PrimarySidebar } from "./components/layout/sidebar";
import { SplitRoot } from "./components/layout/split-root";
import {
  closeLeafTab,
  createSplitState,
  resolveTargetSplitId,
  setActiveSplit,
  setActiveTab,
  toggleSecondarySplit,
  upsertLeafTab,
  type PaneLeaf,
  type SplitTarget,
} from "./components/layout/split-state";
import { Topbar } from "./components/layout/topbar";
import { usePrimarySidebarOverlayMode } from "./components/layout/use-primary-sidebar-overlay-mode";
import { AddRepositoryDialog } from "./components/repositories/add-repository-dialog";
import { CloneRepositoryDialog } from "./components/repositories/clone-repository-dialog";
import { CreateTaskDialog, EditTaskDialog } from "./components/task";
import { client } from "./lib/client";
import { orpc } from "./lib/orpc";
import { queryClient } from "./lib/query-client";
import { useAppStore } from "./stores";

const SECONDARY_SPLIT_ID = "split-secondary";

function getLeafTitle(kind: string): string {
  if (kind === "terminal") return "Terminal";
  if (kind === "diff") return "Diff";
  return kind;
}

function toDiffFileInfo(value: unknown): DiffFileInfo | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<DiffFileInfo>;
  if (
    typeof candidate.path === "string" &&
    typeof candidate.staged === "boolean" &&
    typeof candidate.insertions === "number" &&
    typeof candidate.deletions === "number"
  ) {
    return candidate as DiffFileInfo;
  }

  return null;
}

function App(): React.JSX.Element {
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

  const currentTaskId = useAppStore((s) => s.currentTaskId);
  const setCurrentTask = useAppStore((s) => s.setCurrentTask);
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const selectWorktree = useAppStore((s) => s.selectWorktree);
  const addWorktreeTerminal = useAppStore((s) => s.addWorktreeTerminal);
  const removeWorktreeTerminal = useAppStore((s) => s.removeWorktreeTerminal);
  const clearActiveTerminalId = useAppStore((s) => s.clearActiveTerminalId);

  const [addRepositoryPath, setAddRepositoryPath] = useState<string | null>(null);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [showCreateTaskDialog, setShowCreateTaskDialog] = useState(false);
  const [createTaskRepositoryId, setCreateTaskRepositoryId] = useState<string | null>(null);
  const [showLabelManagerDialog, setShowLabelManagerDialog] = useState(false);
  const [labelManagerRepositoryId, setLabelManagerRepositoryId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [showEditTaskDialog, setShowEditTaskDialog] = useState(false);
  const [editTaskTarget, setEditTaskTarget] = useState<Task | null>(null);
  const [isPrimarySidebarOverlayOpen, setIsPrimarySidebarOverlayOpen] = useState(false);
  const [splitState, setSplitState] = useState(() => createSplitState());

  const isPrimarySidebarOverlayMode = usePrimarySidebarOverlayMode();

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
      const workspaceQueryData = queryClient.getQueryData(orpc.workspace.list.queryKey({}));
      const archivedTaskWorktrees = Object.values(workspaceQueryData?.worktreesByRepository ?? {})
        .flat()
        .filter((w) => w.taskId === variables.taskId);

      if (currentTaskId === variables.taskId) {
        setCurrentTask(null);
        selectWorktree(null);
      }

      archivedTaskWorktrees.forEach((worktree) => {
        removeWorktreeTerminal(worktree.id);
        clearActiveTerminalId(worktree.id);
      });

      if (workspaceQueryData) {
        const updatedWorktreesByRepository = { ...workspaceQueryData.worktreesByRepository };
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

      queryClient.invalidateQueries({ queryKey: orpc.task.key() });
    },
    onError: (error) => setMutationError(String(error)),
  });

  useEffect(() => {
    if (selectedWorktreeId) {
      addWorktreeTerminal(selectedWorktreeId);
    }
  }, [selectedWorktreeId, addWorktreeTerminal]);

  useEffect(() => {
    if (!isPrimarySidebarOverlayMode) {
      setIsPrimarySidebarOverlayOpen(false);
    }
  }, [isPrimarySidebarOverlayMode]);

  const selectedWorktree = useMemo(() => {
    if (!selectedWorktreeId) return null;
    for (const worktrees of Object.values(worktreesByRepository)) {
      const found = worktrees.find((w) => w.id === selectedWorktreeId);
      if (found) return found;
    }
    return null;
  }, [selectedWorktreeId, worktreesByRepository]);

  const { data: selectedTaskData } = useQuery(
    orpc.task.get.queryOptions({
      input: currentTaskId ? { taskId: currentTaskId } : skipToken,
    }),
  );

  const selectedTask = selectedTaskData?.task ?? null;
  const selectedTaskWorktree = selectedTaskData?.worktrees[0] ?? null;

  const selectedRepository = useMemo(() => {
    if (selectedTask) {
      return repositories.find((r) => r.id === selectedTask.repositoryId) ?? null;
    }
    if (selectedWorktree) {
      return repositories.find((r) => r.id === selectedWorktree.repositoryId) ?? null;
    }
    return null;
  }, [selectedTask, selectedWorktree, repositories]);

  const buildPaneLeaf = useCallback((splitId: string, kind: string, state?: unknown): PaneLeaf => {
    return {
      id: `${splitId}:${kind}`,
      kind,
      title: getLeafTitle(kind),
      state,
    };
  }, []);

  useEffect(() => {
    if (!selectedWorktreeId) {
      setSplitState(createSplitState());
      return;
    }

    let seeded = createSplitState();
    const primarySplitId = seeded.primarySplitId;
    seeded = upsertLeafTab(seeded, "primary", buildPaneLeaf(primarySplitId, "terminal"));
    seeded = upsertLeafTab(seeded, "primary", buildPaneLeaf(primarySplitId, "diff"));
    seeded = setActiveTab(seeded, primarySplitId, `${primarySplitId}:terminal`);
    setSplitState(seeded);
  }, [buildPaneLeaf, selectedWorktreeId]);

  const activeLeaf = useMemo(() => {
    const splitId = splitState.activeSplitId;
    const tabs = splitState.tabsBySplitId[splitId] ?? [];
    const activeTabId = splitState.activeTabBySplitId[splitId] ?? null;
    return tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  }, [splitState.activeSplitId, splitState.activeTabBySplitId, splitState.tabsBySplitId]);

  const selectedDiffPath = useMemo(() => {
    if (!activeLeaf || activeLeaf.kind !== "diff") {
      return undefined;
    }

    const diffFile = toDiffFileInfo(activeLeaf.state);
    return diffFile?.path;
  }, [activeLeaf]);

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

      if (isPrimarySidebarOverlayMode) {
        setIsPrimarySidebarOverlayOpen(false);
      }
    },
    [addWorktreeTerminal, isPrimarySidebarOverlayMode, selectWorktree, setCurrentTask],
  );

  const handleArchiveTask = useCallback(
    (taskId: string, commitFirst: boolean) => {
      archiveTaskMutation.mutate({ taskId, deleteWorktree: true, commitFirst });
    },
    [archiveTaskMutation],
  );

  const handleRefresh = () => {
    // Queries are refreshed through invalidation in mutations and hooks.
  };

  const handleToggleSecondarySplit = useCallback(() => {
    setSplitState((current) => {
      const next = toggleSecondarySplit(current, () => SECONDARY_SPLIT_ID);
      const addedSecondary =
        next.splitOrder.length > current.splitOrder.length && next.splitOrder.length > 1;

      if (!addedSecondary) {
        return next;
      }

      const secondarySplitId =
        next.splitOrder.find((id) => id !== next.primarySplitId) ?? SECONDARY_SPLIT_ID;
      let seeded = upsertLeafTab(
        next,
        { splitId: secondarySplitId },
        buildPaneLeaf(secondarySplitId, "terminal"),
      );
      seeded = upsertLeafTab(
        seeded,
        { splitId: secondarySplitId },
        buildPaneLeaf(secondarySplitId, "diff"),
      );
      seeded = setActiveTab(seeded, secondarySplitId, `${secondarySplitId}:terminal`);
      return seeded;
    });
  }, [buildPaneLeaf]);

  const handleActivateSplit = useCallback((splitId: string) => {
    setSplitState((current) => setActiveSplit(current, splitId));
  }, []);

  const handleActivateTab = useCallback((splitId: string, tabId: string) => {
    setSplitState((current) => setActiveTab(current, splitId, tabId));
  }, []);

  const handleOpenLeaf = useCallback(
    (splitId: string, kind: string) => {
      setSplitState((current) => {
        return upsertLeafTab(current, { splitId }, buildPaneLeaf(splitId, kind));
      });
    },
    [buildPaneLeaf],
  );

  const handleCloseTab = useCallback((splitId: string, tabId: string) => {
    setSplitState((current) => closeLeafTab(current, splitId, tabId));
  }, []);

  const handleSelectDiffFile = useCallback(
    (file: DiffFileInfo) => {
      setSplitState((current) => {
        const target: SplitTarget = "active";
        const targetSplitId = resolveTargetSplitId(current, target);
        return upsertLeafTab(
          current,
          { splitId: targetSplitId },
          buildPaneLeaf(targetSplitId, "diff", file),
        );
      });
    },
    [buildPaneLeaf],
  );

  const clearError = () => setMutationError(null);

  const primarySidebarProps = {
    repositories,
    currentTaskId,
    isLoading: isLoadingRepositories,
    onAddRepository: handleAddRepository,
    onCloneRepository: () => setShowCloneDialog(true),
    onCreateTask: handleCreateTask,
    onSelectTask: handleSelectTask,
    onArchiveTask: handleArchiveTask,
    onManageLabels: handleManageLabels,
  };

  return (
    <>
      <PrimarySidebarOverlay
        open={isPrimarySidebarOverlayOpen}
        onOpenChange={setIsPrimarySidebarOverlayOpen}
        {...primarySidebarProps}
      />

      <Splitter
        defaultSize={[20, 80]}
        panels={[
          { id: "app-layout-primary-sidebar", minSize: 15, maxSize: 30 },
          { id: "app-layout-main" },
        ]}
      >
        {!isPrimarySidebarOverlayMode && (
          <>
            <SplitterPanel id="app-layout-primary-sidebar">
              <PrimarySidebar {...primarySidebarProps} />
            </SplitterPanel>
            <SplitterResizeTrigger id="app-layout-primary-sidebar:app-layout-main">
              <SplitterResizeTriggerIndicator />
            </SplitterResizeTrigger>
          </>
        )}

        <SplitterPanel id="app-layout-main" className="flex flex-col">
          <Topbar
            repository={selectedRepository}
            task={selectedTask}
            worktree={selectedTaskWorktree}
            onRemoveRepository={(repositoryId) => removeRepoMutation.mutate({ repositoryId })}
            onEditTask={handleEditTask}
            onArchiveTask={handleHeaderArchiveTask}
            onRefresh={handleRefresh}
            showSidebarToggle={isPrimarySidebarOverlayMode}
            onTogglePrimarySidebar={() => setIsPrimarySidebarOverlayOpen((open) => !open)}
            canToggleSplit={selectedWorktree !== null}
            hasSecondarySplit={splitState.splitOrder.length > 1}
            onToggleSecondarySplit={handleToggleSecondarySplit}
          />
          <Splitter
            defaultSize={[75, 25]}
            panels={[
              { id: "app-layout-split-root" },
              { id: "app-layout-secondary-sidebar", minSize: 20, maxSize: 50 },
            ]}
          >
            <SplitterPanel id="app-layout-split-root">
              {selectedWorktree ? (
                <SplitRoot
                  splitOrder={splitState.splitOrder}
                  activeSplitId={splitState.activeSplitId}
                  tabsBySplitId={splitState.tabsBySplitId}
                  activeTabBySplitId={splitState.activeTabBySplitId}
                  selectedWorktree={selectedWorktree}
                  onActivateSplit={handleActivateSplit}
                  onActivateTab={handleActivateTab}
                  onOpenLeaf={handleOpenLeaf}
                  onCloseTab={handleCloseTab}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center">
                  <div className="bg-muted mb-5 flex h-14 w-14 items-center justify-center rounded-2xl">
                    <FolderGit2 className="text-muted-foreground h-7 w-7" />
                  </div>
                  <h2 className="text-foreground mb-1 text-[15px] font-semibold">
                    No Task Selected
                  </h2>
                  <p className="text-muted-foreground max-w-xs text-center text-[13px]">
                    Select a task from the sidebar to open a split
                  </p>
                </div>
              )}
            </SplitterPanel>
            <SplitterResizeTrigger id="app-layout-split-root:app-layout-secondary-sidebar">
              <SplitterResizeTriggerIndicator />
            </SplitterResizeTrigger>
            <SplitterPanel id="app-layout-secondary-sidebar">
              <SecondarySidebar
                worktree={selectedWorktree}
                selectedPath={selectedDiffPath}
                onFileSelect={handleSelectDiffFile}
              />
            </SplitterPanel>
          </Splitter>
        </SplitterPanel>
      </Splitter>

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
    </>
  );
}

export default App;
