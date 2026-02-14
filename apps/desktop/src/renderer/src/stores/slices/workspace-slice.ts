import type { StateCreator } from "zustand/vanilla";

export interface WorkspaceSlice {
  // Worktree selection
  selectedWorktreeId: string | null;
  selectWorktree: (id: string | null) => void;
}

export const createWorkspaceSlice: StateCreator<WorkspaceSlice, [], [], WorkspaceSlice> = (
  set,
) => ({
  // State
  selectedWorktreeId: null,

  // Actions
  selectWorktree: (id) => set({ selectedWorktreeId: id }),
});
