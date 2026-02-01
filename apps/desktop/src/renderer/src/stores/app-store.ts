import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { createTaskSlice, createTerminalSlice, createWorkspaceSlice } from "./slices";

import type { TaskSlice, TerminalSlice, WorkspaceSlice } from "./slices";

export type AppStore = WorkspaceSlice & TerminalSlice & TaskSlice;

// Vanilla store - can be used outside React
export const appStore = createStore<AppStore>()((...a) => ({
	...createWorkspaceSlice(...a),
	...createTerminalSlice(...a),
	...createTaskSlice(...a),
}));

// React hook with selector support
export function useAppStore<T>(selector: (state: AppStore) => T): T {
	return useStore(appStore, selector);
}
