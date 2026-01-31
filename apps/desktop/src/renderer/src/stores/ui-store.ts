import { useStore } from "zustand";
import { persist } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

interface UIState {
  // Not persisted - transient UI state
  selectedWorktreeId: string | null;

  // Persisted - user preferences
  expandedRepositories: string[];
  sidebarWidth: number;
}

interface UIActions {
  selectWorktree: (id: string | null) => void;
  toggleRepository: (id: string) => void;
  expandRepository: (id: string) => void;
  collapseRepository: (id: string) => void;
  setExpandedRepositories: (ids: string[]) => void;
  setSidebarWidth: (width: number) => void;
}

type UIStore = UIState & UIActions;

// Vanilla store - can be used outside React (e.g., in mutation onSuccess callbacks)
export const uiStore = createStore<UIStore>()(
  persist(
    (set) => ({
      // State
      selectedWorktreeId: null,
      expandedRepositories: [],
      sidebarWidth: 240,

      // Actions
      selectWorktree: (id) => set({ selectedWorktreeId: id }),

      toggleRepository: (id) =>
        set((state) => ({
          expandedRepositories: state.expandedRepositories.includes(id)
            ? state.expandedRepositories.filter((x) => x !== id)
            : [...state.expandedRepositories, id],
        })),

      expandRepository: (id) =>
        set((state) => ({
          expandedRepositories: state.expandedRepositories.includes(id)
            ? state.expandedRepositories
            : [...state.expandedRepositories, id],
        })),

      collapseRepository: (id) =>
        set((state) => ({
          expandedRepositories: state.expandedRepositories.filter((x) => x !== id),
        })),

      setExpandedRepositories: (ids) => set({ expandedRepositories: ids }),

      setSidebarWidth: (width) => set({ sidebarWidth: width }),
    }),
    {
      name: "vibest-ui",
      // Only persist user preferences, not transient UI state
      partialize: (state) => ({
        expandedRepositories: state.expandedRepositories,
        sidebarWidth: state.sidebarWidth,
      }),
    },
  ),
);

// React hook - use in components with selector support
export function useUIStore<T>(selector: (state: UIStore) => T): T {
  return useStore(uiStore, selector);
}
