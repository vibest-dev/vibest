import type { StateCreator } from "zustand";

export interface UISlice {
	// Worktree selection
	selectedWorktreeId: string | null;
	selectWorktree: (id: string | null) => void;

	// Repository expansion
	expandedRepositories: string[];
	toggleRepository: (id: string) => void;
	expandRepository: (id: string) => void;
	collapseRepository: (id: string) => void;
	setExpandedRepositories: (ids: string[]) => void;

	// Layout
	sidebarWidth: number;
	setSidebarWidth: (width: number) => void;
}

export const createUISlice: StateCreator<UISlice, [], [], UISlice> = (set) => ({
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
});
