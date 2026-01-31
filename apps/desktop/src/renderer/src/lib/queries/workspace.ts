import { createTanstackQueryUtils } from "@orpc/tanstack-query";

import { appStore } from "../../stores/app-store";
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
      const state = appStore.getState();
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
      appStore.getState().expandRepository(worktree.repositoryId);
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
      // Prefetch git status for the new worktree
      queryClient.prefetchQuery(orpc.git.status.queryOptions({ input: { path: worktree.path } }));
    },
  };
}

export function quickCreateWorktreeMutationCallbacks() {
  return {
    onSuccess: (worktree: { repositoryId: string; path: string }) => {
      appStore.getState().expandRepository(worktree.repositoryId);
      queryClient.invalidateQueries({ queryKey: orpc.workspace.key() });
      // Prefetch git status for the new worktree
      queryClient.prefetchQuery(orpc.git.status.queryOptions({ input: { path: worktree.path } }));
    },
  };
}

export function removeWorktreeMutationCallbacks() {
  return {
    onSuccess: (_: unknown, variables: { worktreeId: string; force?: boolean }) => {
      const state = appStore.getState();
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
      const state = appStore.getState();
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
