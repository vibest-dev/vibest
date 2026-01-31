import { createTanstackQueryUtils } from "@orpc/tanstack-query";

import { uiStore } from "../../stores/ui-store";
import { client } from "../client";
import { queryClient } from "../query-client";

// Create oRPC TanStack Query utils
export const orpc = createTanstackQueryUtils(client);

// ============ Custom Mutation Callbacks ============
// These handle side effects like UI state updates after mutations

export function addRepositoryMutationCallbacks() {
  return {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
    },
  };
}

export function cloneRepositoryMutationCallbacks() {
  return {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
    },
  };
}

export function removeRepositoryMutationCallbacks() {
  return {
    onSuccess: (_: unknown, variables: { repositoryId: string }) => {
      // Clear selection if the selected worktree belongs to this repository
      const state = uiStore.getState();
      const workspaceData = queryClient.getQueryData(orpc.workspace.list.queryKey({}));
      if (workspaceData) {
        const worktrees = workspaceData.worktreesByRepository[variables.repositoryId];
        if (worktrees?.some((w) => w.id === state.selectedWorktreeId)) {
          state.selectWorktree(null);
        }
      }
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
    },
  };
}

export function createWorktreeMutationCallbacks() {
  return {
    onSuccess: (worktree: { repositoryId: string; path: string }) => {
      uiStore.getState().expandRepository(worktree.repositoryId);
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
      // Prefetch git status for the new worktree
      queryClient.prefetchQuery(orpc.git.status.queryOptions({ input: { path: worktree.path } }));
    },
  };
}

export function quickCreateWorktreeMutationCallbacks() {
  return {
    onSuccess: (worktree: { repositoryId: string; path: string }) => {
      uiStore.getState().expandRepository(worktree.repositoryId);
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
      // Prefetch git status for the new worktree
      queryClient.prefetchQuery(orpc.git.status.queryOptions({ input: { path: worktree.path } }));
    },
  };
}

export function removeWorktreeMutationCallbacks() {
  return {
    onSuccess: (_: unknown, variables: { worktreeId: string; force?: boolean }) => {
      const state = uiStore.getState();
      if (state.selectedWorktreeId === variables.worktreeId) {
        state.selectWorktree(null);
      }
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
    },
  };
}

export function archiveWorktreeMutationCallbacks() {
  return {
    onSuccess: (_: unknown, variables: { worktreeId: string; commitFirst?: boolean }) => {
      const state = uiStore.getState();
      if (state.selectedWorktreeId === variables.worktreeId) {
        state.selectWorktree(null);
      }
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
    },
  };
}

export function gitFetchMutationCallbacks() {
  return {
    onSuccess: (_: unknown, variables: { path: string }) => {
      // Invalidate git status for this path
      queryClient.invalidateQueries({
        queryKey: orpc.git.status.key({ input: { path: variables.path } }),
      });
    },
  };
}

export function gitPullMutationCallbacks() {
  return {
    onSuccess: (_: unknown, variables: { path: string }) => {
      // Invalidate git status for this path
      queryClient.invalidateQueries({
        queryKey: orpc.git.status.key({ input: { path: variables.path } }),
      });
    },
  };
}
