import type { StateCreator } from "zustand/vanilla";

export interface WorkspaceSlice {
  // Worktree selection
  selectedWorktreeId: string | null;
  selectWorktree: (id: string | null) => void;

  // Track which worktrees have been opened (for terminal persistence)
  openedWorktreeIds: string[];
  markWorktreeOpened: (worktreeId: string) => void;
  removeWorktreeOpened: (worktreeId: string) => void;
}

export const createWorkspaceSlice: StateCreator<WorkspaceSlice, [], [], WorkspaceSlice> = (
  set,
) => ({
  // State
  selectedWorktreeId: null,
  openedWorktreeIds: [],

  // Actions
  selectWorktree: (id) => set({ selectedWorktreeId: id }),

  markWorktreeOpened: (worktreeId) =>
    set((state) => ({
      openedWorktreeIds: state.openedWorktreeIds.includes(worktreeId)
        ? state.openedWorktreeIds
        : [...state.openedWorktreeIds, worktreeId],
    })),

  removeWorktreeOpened: (worktreeId) =>
    set((state) => ({
      openedWorktreeIds: state.openedWorktreeIds.filter((id) => id !== worktreeId),
    })),
});
