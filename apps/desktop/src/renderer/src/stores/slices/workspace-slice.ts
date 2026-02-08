import type { StateCreator } from "zustand/vanilla";

export interface WorkspaceSlice {
  // Worktree selection
  selectedWorktreeId: string | null;
  selectWorktree: (id: string | null) => void;

  // Track which worktrees have been opened (for terminal persistence)
  worktreeTerminalIds: string[];
  addWorktreeTerminal: (worktreeId: string) => void;
  removeWorktreeTerminal: (worktreeId: string) => void;
}

export const createWorkspaceSlice: StateCreator<WorkspaceSlice, [], [], WorkspaceSlice> = (
  set,
) => ({
  // State
  selectedWorktreeId: null,
  worktreeTerminalIds: [],

  // Actions
  selectWorktree: (id) => set({ selectedWorktreeId: id }),

  addWorktreeTerminal: (worktreeId) =>
    set((state) => ({
      worktreeTerminalIds: state.worktreeTerminalIds.includes(worktreeId)
        ? state.worktreeTerminalIds
        : [...state.worktreeTerminalIds, worktreeId],
    })),

  removeWorktreeTerminal: (worktreeId) =>
    set((state) => ({
      worktreeTerminalIds: state.worktreeTerminalIds.filter((id) => id !== worktreeId),
    })),
});
