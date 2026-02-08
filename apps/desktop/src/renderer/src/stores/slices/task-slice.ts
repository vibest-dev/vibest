import type { StateCreator } from "zustand/vanilla";

export interface TaskSlice {
	// State
	selectedTaskId: string | null;
	selectedRepositoryId: string | null;

	// Actions
	selectTask: (id: string | null) => void;
	selectRepository: (id: string | null) => void;
}

export const createTaskSlice: StateCreator<TaskSlice, [], [], TaskSlice> = (
	set,
) => ({
	// State
	selectedTaskId: null,
	selectedRepositoryId: null,

	// Actions
	selectTask: (id) => set({ selectedTaskId: id }),
	selectRepository: (id) =>
		set({ selectedRepositoryId: id, selectedTaskId: null }),
});
