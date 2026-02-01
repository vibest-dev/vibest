import type { StateCreator } from "zustand/vanilla";

export interface WorkspaceSlice {
  // Track which worktrees have terminal sessions (for terminal persistence)
  worktreeTerminalIds: string[];
  addWorktreeTerminal: (worktreeId: string) => void;
  removeWorktreeTerminal: (worktreeId: string) => void;
}

export const createWorkspaceSlice: StateCreator<WorkspaceSlice, [], [], WorkspaceSlice> = (
  set,
) => ({
  // State
  worktreeTerminalIds: [],

  // Actions
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
