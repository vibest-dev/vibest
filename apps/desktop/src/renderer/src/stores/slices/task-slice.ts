import type { StateCreator } from "zustand/vanilla";

export interface TaskSlice {
  // State
  currentTaskId: string | null;
  currentRepositoryId: string | null;

  // Actions
  setCurrentTask: (id: string | null) => void;
  setCurrentRepository: (id: string | null) => void;
}

export const createTaskSlice: StateCreator<TaskSlice, [], [], TaskSlice> = (set) => ({
  // State
  currentTaskId: null,
  currentRepositoryId: null,

  // Actions
  setCurrentTask: (id) => set({ currentTaskId: id }),
  setCurrentRepository: (id) => set({ currentRepositoryId: id, currentTaskId: null }),
});
