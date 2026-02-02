import type { StateCreator } from "zustand/vanilla";

export interface TerminalSlice {
  // Active terminal per worktree
  activeTerminalId: Record<string, string | null>;
  setActiveTerminalId: (worktreeId: string, terminalId: string | null) => void;
  clearActiveTerminalId: (worktreeId: string) => void;
}

export const createTerminalSlice: StateCreator<TerminalSlice, [], [], TerminalSlice> = (set) => ({
  // State
  activeTerminalId: {},

  // Actions
  setActiveTerminalId: (worktreeId, terminalId) =>
    set((state) => ({
      activeTerminalId: {
        ...state.activeTerminalId,
        [worktreeId]: terminalId,
      },
    })),

  clearActiveTerminalId: (worktreeId) =>
    set((state) => {
      const { [worktreeId]: _, ...rest } = state.activeTerminalId;
      return { activeTerminalId: rest };
    }),
});
